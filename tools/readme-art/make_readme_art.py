"""
The README's art: a banner and four diagrams, drawn with Pillow from Weir's own design tokens.

    pip install -r tools/readme-art/requirements.txt
    python tools/readme-art/make_readme_art.py            write every image
    python tools/readme-art/make_readme_art.py --check    audit and lay out, write nothing

Output: assets/readme/banner.webp and {flow,architecture,mandate,family}.png, committed, because GitHub
renders the README from the repository.

How it is built, and why:

- Colours are read from apps/web/src/styles/tokens.css, never retyped, so a figure cannot drift
  from the product. The paper page, white cards, ink text and Weir teal are the app's own.
- Type is Geist, the app's typeface, unpacked from the web font the app already installs
  (@fontsource-variable/geist) and set by weight on its variable axis. A missing font exits 2:
  a substituted font would invalidate every measurement.
- Every text colour is audited against every surface it lands on before anything is written;
  anything under 4.5:1 exits 1. Muted and accent text are derived to pass, not assumed. On the
  banner the check samples the photograph behind each line of text.
- Layout is measured: text wraps on rendered widths, and one flow function both measures a card
  and draws it, so a card can never be drawn taller or wider than it was measured.
- Images are drawn at 2x and kept at 2x (2200 px wide), shown at the README's column width, so
  they stay sharp on high-density screens.
- Shadows are blurred on their own layer and composited; ImageDraw does not composite alpha, so
  nothing translucent is drawn with it directly.
"""

from __future__ import annotations

import argparse
import colorsys
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assets" / "readme"
# The banner is a photograph: as a PNG it weighs 2 MB, as a WebP (alpha kept for its corners) a tenth.
FORMAT = {"banner": "webp"}
TOKENS = ROOT / "apps" / "web" / "src" / "styles" / "tokens.css"
MARK = ROOT / "brand" / "weir-icon.png"
PHOTO = ROOT / "apps" / "landing" / "public" / "media" / "hero-frame.webp"
FONT_DIR = ROOT / "node_modules" / ".pnpm"
GEIST = "@fontsource-variable+geist@*/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"
GEIST_MONO = "@fontsource-variable+geist-mono@*/node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2"

SCALE = 2
WIDTH = 1100
PAD = 44
GAP = 18
RADIUS = 20


def px(value: float) -> int:
    return int(round(value * SCALE))


# --------------------------------------------------------------------------------------------
# Colour
# --------------------------------------------------------------------------------------------


def parse_hex(colour: str) -> tuple[int, int, int]:
    text = colour.strip().lstrip("#")
    if len(text) == 3:
        text = "".join(c * 2 for c in text)
    return tuple(int(text[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def to_hex(rgb: tuple[float, float, float]) -> str:
    return "#%02X%02X%02X" % tuple(max(0, min(255, round(c))) for c in rgb)


def blend(top: str, bottom: str, alpha: float) -> str:
    t, b = parse_hex(top), parse_hex(bottom)
    return to_hex(tuple(t[i] * alpha + b[i] * (1 - alpha) for i in range(3)))


def luminance(rgb: tuple[int, int, int]) -> float:
    def channel(v: int) -> float:
        c = v / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(v) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str | tuple[int, int, int], b: str | tuple[int, int, int]) -> float:
    la = luminance(parse_hex(a) if isinstance(a, str) else a)
    lb = luminance(parse_hex(b) if isinstance(b, str) else b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def readable(colour: str, *surfaces: str) -> str:
    """The nearest colour to `colour`, same hue and saturation, that clears 4.5:1 on every surface."""
    h, s, v = colorsys.rgb_to_hsv(*[c / 255 for c in parse_hex(colour)])

    def at(value: float) -> str:
        return to_hex(tuple(c * 255 for c in colorsys.hsv_to_rgb(h, s, value)))

    def ok(c: str) -> bool:
        return all(contrast(c, surface) >= 4.5 for surface in surfaces)

    if ok(colour):
        return colour
    for step in range(1, 50):
        for direction in (-1, 1):
            value = v + direction * step * 0.02
            if 0 <= value <= 1 and ok(at(value)):
                return at(value)
    raise SystemExit(f"no readable variant of {colour}")


def read_tokens(path: Path) -> dict[str, str]:
    text = path.read_text()
    root = text[text.index(":root") : text.index("}", text.index(":root"))]
    return dict(re.findall(r"(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\s*;", root))


@dataclass(frozen=True)
class Palette:
    paper: str
    surface: str
    sunk: str
    ink: str
    accent: str
    accent_soft: str
    accent_bright: str
    line: str
    text_soft: str  # secondary text, derived
    text_muted: str  # captions and arrow labels, derived
    accent_text: str  # accent for reading, derived
    on_ink_soft: str  # secondary text on an ink card


def palette() -> Palette:
    t = read_tokens(TOKENS)
    need = ["--bg", "--surface", "--surface-sunk", "--ink", "--accent", "--accent-soft", "--accent-bright"]
    missing = [k for k in need if k not in t]
    if missing:
        raise SystemExit(f"tokens.css lacks {missing}")
    paper, surface, ink = t["--bg"], t["--surface"], t["--ink"]
    surfaces = (paper, surface, t["--accent-soft"])
    return Palette(
        paper=paper,
        surface=surface,
        sunk=t["--surface-sunk"],
        ink=ink,
        accent=t["--accent"],
        accent_soft=t["--accent-soft"],
        accent_bright=t["--accent-bright"],
        line=blend(ink, surface, 0.12),
        text_soft=readable(blend(ink, surface, 0.78), *surfaces),
        text_muted=readable(blend(ink, surface, 0.6), *surfaces),
        accent_text=readable(t["--accent"], *surfaces),
        on_ink_soft=readable(blend(surface, ink, 0.72), ink),
    )


def audit(p: Palette) -> list[str]:
    pairs = [
        ("ink", p.ink, ("paper", p.paper), ("surface", p.surface), ("accent soft", p.accent_soft)),
        ("soft text", p.text_soft, ("paper", p.paper), ("surface", p.surface), ("accent soft", p.accent_soft)),
        ("muted text", p.text_muted, ("paper", p.paper), ("surface", p.surface), ("accent soft", p.accent_soft)),
        ("accent text", p.accent_text, ("paper", p.paper), ("surface", p.surface), ("accent soft", p.accent_soft)),
        ("white on ink", p.surface, ("ink", p.ink)),
        ("soft on ink", p.on_ink_soft, ("ink", p.ink)),
        ("bright accent on ink", p.accent_bright, ("ink", p.ink)),
        ("white on accent", p.surface, ("accent", p.accent)),
    ]
    problems = []
    for name, colour, *surfaces in pairs:
        for surface_name, surface in surfaces:
            ratio = contrast(colour, surface)
            mark = "ok  " if ratio >= 4.5 else "FAIL"
            print(f"  {mark} {name:21} {colour} on {surface_name:11} {surface}  {ratio:5.2f}:1")
            if ratio < 4.5:
                problems.append(f"{name} on {surface_name}")
    return problems


# --------------------------------------------------------------------------------------------
# Type
# --------------------------------------------------------------------------------------------

_FONT_FILES: dict[str, Path] = {}
_FONTS: dict[tuple[str, int, int], ImageFont.FreeTypeFont] = {}


def load_fonts(cache: Path) -> None:
    from fontTools.ttLib import TTFont

    for name, pattern in (("sans", GEIST), ("mono", GEIST_MONO)):
        found = sorted(FONT_DIR.glob(pattern))
        if not found:
            print(f"ERROR: the {name} font is missing ({pattern} under {FONT_DIR}). Run pnpm install.")
            sys.exit(2)
        target = cache / f"{name}.ttf"
        font = TTFont(str(found[-1]))
        font.flavor = None
        font.save(str(target))
        _FONT_FILES[name] = target


def font(size: float, weight: int = 400, family: str = "sans") -> ImageFont.FreeTypeFont:
    key = (family, px(size), weight)
    if key not in _FONTS:
        f = ImageFont.truetype(str(_FONT_FILES[family]), px(size))
        f.set_variation_by_axes([weight])
        _FONTS[key] = f
    return _FONTS[key]


def line_height(f: ImageFont.FreeTypeFont, leading: float = 1.3) -> int:
    ascent, descent = f.getmetrics()
    return int((ascent + descent) * leading)


_PROBE = ImageDraw.Draw(Image.new("RGB", (8, 8)))
_CMAPS: dict[str, set[int]] = {}


def require_glyphs(text: str, f: ImageFont.FreeTypeFont) -> None:
    """Exit 2 on any character the font lacks: Pillow would draw an empty box in its place."""
    path = str(f.path)
    if path not in _CMAPS:
        from fontTools.ttLib import TTFont

        _CMAPS[path] = set(TTFont(path).getBestCmap())
    missing = sorted({ch for ch in text if not ch.isspace() and ord(ch) not in _CMAPS[path]})
    if missing:
        print(f"ERROR: {Path(path).name} has no glyph for {missing} in {text!r}")
        sys.exit(2)


def width_of(text: str, f: ImageFont.FreeTypeFont) -> int:
    require_glyphs(text, f)
    return int(_PROBE.textlength(text, font=f))


def wrap(text: str, f: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    require_glyphs(text, f)
    lines: list[str] = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            if width_of(f"{current} {word}", f) <= max_width:
                current = f"{current} {word}"
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


# --------------------------------------------------------------------------------------------
# Cards: one flow, used to measure and to draw
# --------------------------------------------------------------------------------------------


@dataclass
class Item:
    text: str
    note: str = ""
    mono: bool = False


@dataclass
class Card:
    title: str
    kicker: str = ""  # small caps line above the title
    body: str = ""
    items: list[Item] = field(default_factory=list)
    pills: list[str] = field(default_factory=list)
    style: str = "light"  # light, ink, soft
    number: int | None = None


CARD_PAD = 20


def card_colours(p: Palette, style: str) -> dict[str, str]:
    if style == "ink":
        return {"fill": p.ink, "title": p.surface, "body": p.on_ink_soft, "kicker": p.accent_bright,
                "dot": p.accent_bright, "pill_fill": blend(p.surface, p.ink, 0.12), "pill_text": p.surface,
                "mono": p.surface}
    fill = p.accent_soft if style == "soft" else p.surface
    return {"fill": fill, "title": p.ink, "body": p.text_soft, "kicker": p.accent_text, "dot": p.accent,
            "pill_fill": p.paper if style == "light" else p.surface, "pill_text": p.accent_text, "mono": p.ink}


Op = tuple  # (kind, x, y, payload...)


def flow(card: Card, width: int, p: Palette) -> tuple[list[Op], int]:
    """Every drawing operation for `card`, relative to its top left, and its height."""
    c = card_colours(p, card.style)
    ops: list[Op] = []
    inner = width - px(CARD_PAD) * 2
    x0, y = px(CARD_PAD), px(CARD_PAD)
    if card.number is not None:
        d = px(28)
        ops.append(("number", x0, y, d, str(card.number)))
        y += d + px(12)
    if card.kicker:
        f = font(8.5, 600)
        ops.append(("text", x0, y, card.kicker.upper(), f, c["kicker"], px(1.4)))
        y += line_height(f) + px(4)
    f = font(15, 500)
    for line in wrap(card.title, f, inner):
        ops.append(("text", x0, y, line, f, c["title"], 0))
        y += line_height(f, 1.18)
    if card.body:
        y += px(6)
        f = font(10.5, 400)
        for line in wrap(card.body, f, inner):
            ops.append(("text", x0, y, line, f, c["body"], 0))
            y += line_height(f, 1.42)
    if card.items:
        y += px(10)
        for item in card.items:
            f = font(10, 400, "mono") if item.mono else font(10.5, 500)
            lines = wrap(item.text, f, inner - px(14))
            ops.append(("dot", x0, y + line_height(f) // 2 - px(4), c["dot"]))
            for line in lines:
                ops.append(("text", x0 + px(14), y, line, f, c["mono"] if item.mono else c["title"], 0))
                y += line_height(f, 1.32)
            if item.note:
                nf = font(9.5, 400)
                for line in wrap(item.note, nf, inner - px(14)):
                    ops.append(("text", x0 + px(14), y, line, nf, c["body"], 0))
                    y += line_height(nf, 1.36)
            y += px(7)
        y -= px(7)
    if card.pills:
        y += px(14)
        f = font(9, 500)
        px_, row_h = x0, line_height(f) + px(10)
        for pill in card.pills:
            w = width_of(pill, f) + px(20)
            if px_ + w > x0 + inner and px_ > x0:
                px_, y = x0, y + row_h + px(6)
            ops.append(("pill", px_, y, w, row_h, pill, f, c["pill_fill"], c["pill_text"]))
            px_ += w + px(6)
        y += row_h
    return ops, y + px(CARD_PAD)


def shadow(base: Image.Image, box: tuple[int, int, int, int], radius: int, strength: int = 26) -> None:
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    x0, y0, x1, y1 = box
    ImageDraw.Draw(layer).rounded_rectangle((x0, y0 + px(8), x1, y1 + px(8)), radius=radius, fill=(24, 22, 27, strength))
    layer = layer.filter(ImageFilter.GaussianBlur(px(14)))
    base.alpha_composite(layer)


def draw_ops(image: Image.Image, ops: list[Op], ox: int, oy: int, p: Palette) -> None:
    draw = ImageDraw.Draw(image)
    for op in ops:
        kind = op[0]
        if kind == "text":
            _, x, y, text, f, fill, tracking = op
            if tracking:
                cx = ox + x
                for ch in text:
                    draw.text((cx, oy + y), ch, font=f, fill=fill)
                    cx += width_of(ch, f) + tracking
            else:
                draw.text((ox + x, oy + y), text, font=f, fill=fill)
        elif kind == "dot":
            _, x, y, fill = op
            draw.ellipse((ox + x, oy + y, ox + x + px(5), oy + y + px(5)), fill=fill)
        elif kind == "pill":
            _, x, y, w, h, text, f, fill, colour = op
            draw.rounded_rectangle((ox + x, oy + y, ox + x + w, oy + y + h), radius=h // 2, fill=fill)
            draw.text((ox + x + px(10), oy + y + (h - line_height(f, 1.0)) // 2 - px(0.5)), text, font=f, fill=colour)
        elif kind == "number":
            _, x, y, d, text = op
            draw.ellipse((ox + x, oy + y, ox + x + d, oy + y + d), fill=p.accent)
            f = font(11, 600)
            tw = width_of(text, f)
            draw.text((ox + x + (d - tw) // 2, oy + y + (d - line_height(f, 1.0)) // 2 - px(0.5)), text, font=f, fill=p.surface)


def draw_card(image: Image.Image, card: Card, x: int, y: int, width: int, height: int, p: Palette) -> None:
    ops, _ = flow(card, width, p)
    c = card_colours(p, card.style)
    if card.style != "soft":
        shadow(image, (x, y, x + width, y + height), px(RADIUS), 34 if card.style == "ink" else 22)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((x, y, x + width, y + height), radius=px(RADIUS), fill=c["fill"])
    draw_ops(image, ops, x, y, p)


# --------------------------------------------------------------------------------------------
# Figures
# --------------------------------------------------------------------------------------------


def header(eyebrow: str, title: str, subtitle: str, p: Palette) -> tuple[list[Op], int]:
    ops: list[Op] = []
    x, y = px(PAD), px(PAD)
    f = font(9, 600)
    ops.append(("text", x, y, eyebrow.upper(), f, p.accent_text, px(1.6)))
    y += line_height(f) + px(6)
    f = font(30, 300)
    for line in wrap(title, f, px(WIDTH - PAD * 2)):
        ops.append(("text", x - px(1.5), y, line, f, p.ink, 0))
        y += line_height(f, 1.1)
    y += px(4)
    f = font(11.5, 400)
    for line in wrap(subtitle, f, px(WIDTH - PAD * 2 - 120)):
        ops.append(("text", x, y, line, f, p.text_soft, 0))
        y += line_height(f, 1.42)
    return ops, y + px(26)


def canvas(height: int, p: Palette) -> Image.Image:
    height += height % 2
    image = Image.new("RGBA", (px(WIDTH), height), (0, 0, 0, 0))
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width - 1, image.height - 1), radius=px(26), fill=255)
    page = Image.new("RGBA", image.size, parse_hex(p.paper) + (255,))
    image.paste(page, (0, 0), mask)
    return image


def corner_mark(image: Image.Image, p: Palette) -> None:
    """The Weir mark and name, top right: every figure is signed the same way."""
    size = px(26)
    mark = Image.open(MARK).convert("RGBA").resize((size, size), Image.LANCZOS)
    f = font(12, 600)
    text_w = width_of("Weir", f)
    x = image.width - px(PAD) - text_w - px(8) - size
    y = px(PAD) - px(4)
    image.alpha_composite(mark, (x, y))
    ImageDraw.Draw(image).text((x + size + px(8), y + (size - line_height(f, 1.0)) // 2 - px(1)), "Weir", font=f, fill=p.ink)


def arrow(draw: ImageDraw.ImageDraw, start: tuple[int, int], end: tuple[int, int], colour: str, label: str = "",
          label_colour: str = "", dashed: bool = True) -> None:
    (x1, y1), (x2, y2) = start, end
    horizontal = abs(x2 - x1) >= abs(y2 - y1)
    length = abs(x2 - x1) if horizontal else abs(y2 - y1)
    head = px(7)
    step, dash = (px(7), px(4)) if dashed else (length, length)
    pos = 0
    while pos < length - head:
        seg = min(dash, length - head - pos)
        if horizontal:
            sx = x1 + (pos if x2 > x1 else -pos)
            ex = sx + (seg if x2 > x1 else -seg)
            draw.line([(sx, y1), (ex, y1)], fill=colour, width=px(1.6))
        else:
            sy = y1 + (pos if y2 > y1 else -pos)
            ey = sy + (seg if y2 > y1 else -seg)
            draw.line([(x1, sy), (x1, ey)], fill=colour, width=px(1.6))
        pos += step if dashed else length
    if horizontal:
        sgn = 1 if x2 > x1 else -1
        draw.polygon([(x2, y2), (x2 - sgn * head, y2 - px(4.5)), (x2 - sgn * head, y2 + px(4.5))], fill=colour)
    else:
        sgn = 1 if y2 > y1 else -1
        draw.polygon([(x2, y2), (x2 - px(4.5), y2 - sgn * head), (x2 + px(4.5), y2 - sgn * head)], fill=colour)
    if label:
        f = font(9, 500)
        w = width_of(label, f)
        if horizontal:
            draw.text(((x1 + x2) // 2 - w // 2, y1 - line_height(f) - px(3)), label, font=f, fill=label_colour)
        else:
            draw.text((x1 + px(10), (y1 + y2) // 2 - line_height(f, 1.0) // 2), label, font=f, fill=label_colour)


def row_layout(cards: list[Card], x: int, width: int, gap: int, p: Palette) -> tuple[list[int], int]:
    """Equal-width cards across `width`: their x positions and the tallest measured height."""
    w = (width - gap * (len(cards) - 1)) // len(cards)
    xs = [x + i * (w + gap) for i in range(len(cards))]
    height = max(flow(card, w, p)[1] for card in cards)
    return xs, height


def figure_flow(p: Palette) -> Image.Image:
    steps = [
        Card("Say yes once", kicker="Payer", number=1,
             body="A passkey makes the account: no seed phrase, no extension, no gas token.",
             items=[Item("Owner key signs the terms", "and a permit for the dollars"),
                    Item("Session key stays on the device", "it can only pause, resume and cancel")]),
        Card("One relayed transaction", kicker="Relayer", number=2,
             body="Weir's relayer submits what the payer signed and pays the fee.",
             items=[Item("permit + createMandateWithSig", mono=True), Item("Multicall3, eth_sendRawTransactionSync", mono=True),
                    Item("Send now adds the charge", "so a one-off arrives in the same transaction")]),
        Card("Charged when due", kicker="MandateHub", number=3, style="ink",
             body="Anyone may call charge. The contract checks every limit and refuses anything early or over.",
             items=[Item("Keeper batches through MandateCharger"), Item("Chainlink CRE reports, signed by the DON"),
                    Item("Short funds move nothing", "the mandate is marked past due and retried")]),
        Card("Straight to the business", kicker="Settlement", number=4,
             body="Money never sits in the contract: it moves payer to merchant in one step.",
             items=[Item("From the balance, or from savings", "a Morpho vault, so it earns until the day it is due"),
                    Item("Savings short? The balance pays", "under the same limits")]),
    ]
    head_ops, top = header("How a payment works", "Say yes once. Pay when it’s due.",
                           "Two signatures from a passkey, one relayed transaction, then charges that can never exceed what the payer agreed to.", p)
    gutter = px(30)
    xs, h = row_layout(steps, px(PAD), px(WIDTH - PAD * 2), gutter, p)
    strip = Card("Stop any time, in one tap", style="soft",
                 body="The session key pauses or cancels on chain at once, with nobody's permission. Revoking the allowance stops every future charge.")
    strip_h = flow(strip, px(WIDTH - PAD * 2), p)[1]
    image = canvas(top + h + px(GAP) + strip_h + px(PAD), p)
    draw_ops(image, head_ops, 0, 0, p)
    corner_mark(image, p)
    w = xs[1] - xs[0] - gutter
    for card, x in zip(steps, xs):
        draw_card(image, card, x, top, w, h, p)
    draw = ImageDraw.Draw(image)
    mid = top + px(CARD_PAD) + px(14)
    for x in xs[1:]:
        arrow(draw, (x - gutter + px(5), mid), (x - px(5), mid), p.accent)
    draw_card(image, strip, px(PAD), top + h + px(GAP), px(WIDTH - PAD * 2), strip_h, p)
    return image


def figure_architecture(p: Palette) -> Image.Image:
    people = [
        Card("Payers", kicker="App", body="Checkout, Your payments, savings, reminders. Installable on a phone."),
        Card("Families", kicker="App", body="One support link, every relative gives on their own, in the recipient's currency."),
        Card("Businesses", kicker="Dashboard", body="Plans, webhooks, revenue from Envio, payouts signed by their Privy wallet."),
        Card("AI agents", kicker="Agent plugin", body="A MetaMask Agent Wallet subscribes and manages its payments by signing."),
    ]
    services = [
        Card("API and relayer", kicker="Railway", body="Decodes every call against an allowlist, bundles installs, pays the gas, indexes with HyperSync."),
        Card("Keeper", kicker="Railway", body="Finds what is due every few seconds and charges it in batches, with tight gas."),
        Card("Chainlink CRE", kicker="Workflow", body="Consensus reads, then one DON-signed report to the charger."),
        Card("Envio HyperIndex", kicker="Indexer", body="Revenue, MRR and daily volume per network, served as GraphQL."),
    ]
    chain = [
        Card("MandateHub", kicker="Monad Mainnet and Testnet", style="ink",
             body="Every mandate and every limit. No owner, no fee, no upgrade path.",
             items=[Item("0x184c6c26…EcA0", mono=True)]),
        Card("MandateCharger", kicker="Contract", body="Charges many at once; the only receiver of CRE reports.",
             items=[Item("0xC555DBb7…CFf03", mono=True)]),
        Card("SavingsRouter", kicker="Contract", body="Moves a payer's dollars into or out of a Morpho vault on their permit.",
             items=[Item("0x9eE63583…0295", mono=True)]),
    ]
    built = Card("Built with", style="soft", pills=["USDC", "AUSD by Agora", "Morpho vaults", "Mera passkeys", "Privy",
                                                     "Chainlink CRE and Data Feeds", "Envio HyperIndex and HyperSync",
                                                     "Aurora Intents", "MetaMask Agent Wallet", "Multicall3"])
    head_ops, top = header("Architecture", "Signatures in, dollars out.",
                           "People only ever sign. Weir's services relay, charge and index; the contracts on Monad hold every rule.", p)
    span = px(WIDTH - PAD * 2)
    gap_v = px(46)
    rows = []
    y = top
    for cards in (people, services, chain):
        xs, h = row_layout(cards, px(PAD), span, px(GAP), p)
        rows.append((cards, xs, y, h))
        y += h + gap_v
    built_h = flow(built, span, p)[1]
    y = y - gap_v + px(GAP)
    image = canvas(y + built_h + px(PAD), p)
    draw_ops(image, head_ops, 0, 0, p)
    corner_mark(image, p)
    for cards, xs, ry, h in rows:
        w = (span - px(GAP) * (len(cards) - 1)) // len(cards)
        for card, x in zip(cards, xs):
            draw_card(image, card, x, ry, w, h, p)
    draw = ImageDraw.Draw(image)
    labels = ["signatures only, never gas", "one transaction each, every call allowlisted"]
    for (cards, xs, ry, h), label in zip(rows[:2], labels):
        start = ry + h + px(6)
        end = start + gap_v - px(12)
        cx = px(WIDTH) // 2
        arrow(draw, (cx, start), (cx, end), p.accent, label, p.text_muted)
    draw_card(image, built, px(PAD), y, span, built_h, p)
    return image


def figure_mandate(p: Palette) -> Image.Image:
    mandate = Card("A $9.99 monthly plan", kicker="One mandate", style="ink",
                   items=[Item("Pays Lumen Studio, and only them"), Item("$9.99 at most per charge"),
                          Item("$119.88 at most in total"), Item("Nothing after 1 October 2027"),
                          Item("Draws from savings, then the balance", "money earns in a Morpho vault until each charge")])
    can = Card("The session key can", kicker="Prompt-free",
               items=[Item("Pause"), Item("Resume"), Item("Cancel")],
               body="Kept on the device, so stopping takes one tap and no passkey prompt.")
    never = Card("Nothing can", kicker="Enforced on chain",
                 items=[Item("Raise a limit"), Item("Change who is paid"), Item("Charge early or more than due"),
                        Item("Hold the money", "it moves payer to merchant in one step")])
    head_ops, top = header("One yes, with limits", "What a mandate allows, and what it never will.",
                           "The payer agrees once to three limits. The contract applies them to every charge, whoever sends it.", p)
    span = px(WIDTH - PAD * 2)
    left_w = int(span * 0.38)
    right_w = span - left_w - px(GAP)
    col_w = (right_w - px(GAP)) // 2
    left_h = flow(mandate, left_w, p)[1]
    right_h = max(flow(can, col_w, p)[1], flow(never, col_w, p)[1])
    body_h = max(left_h, right_h)
    # Its life: running states joined by measured, labelled arrows, then the three ways it ends.
    f = font(10.5, 500)
    pill_h = line_height(f) + px(14)
    kf = font(9, 600)
    nf = font(9.5, 400)
    running = [("Active", "pause"), ("Paused", "resume"), ("Active", "")]
    endings = [("Completed", "its lifetime cap is reached"), ("Expired", "its end date passes"),
               ("Cancelled", "by the payer or the session key")]
    life_top = top + body_h + px(34)
    row1 = life_top + line_height(kf) + px(16)
    row2 = row1 + pill_h + px(18)
    image = canvas(row2 + pill_h + px(PAD), p)
    draw_ops(image, head_ops, 0, 0, p)
    corner_mark(image, p)
    draw_card(image, mandate, px(PAD), top, left_w, body_h, p)
    rx = px(PAD) + left_w + px(GAP)
    draw_card(image, can, rx, top, col_w, body_h, p)
    draw_card(image, never, rx + col_w + px(GAP), top, col_w, body_h, p)
    draw = ImageDraw.Draw(image)
    cx = px(PAD)
    for ch in "ITS LIFE":
        draw.text((cx, life_top), ch, font=kf, fill=p.accent_text)
        cx += width_of(ch, kf) + px(1.6)

    def pill(x: int, y: int, text: str, dark: bool) -> int:
        nonlocal draw
        w = width_of(text, f) + px(28)
        if not dark:
            shadow(image, (x, y, x + w, y + pill_h), pill_h // 2, 16)
            draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((x, y, x + w, y + pill_h), radius=pill_h // 2, fill=p.ink if dark else p.surface)
        draw.text((x + px(14), y + (pill_h - line_height(f, 1.0)) // 2 - px(1)), text, font=f, fill=p.surface if dark else p.ink)
        return w

    x = px(PAD)
    mid = row1 + pill_h // 2
    af = font(9, 500)
    for text, label in running:
        w = pill(x, row1, text, True)
        x += w
        if label:
            gap = max(px(64), width_of(label, af) + px(30))
            arrow(draw, (x + px(5), mid), (x + gap - px(5), mid), p.accent, label, p.text_muted)
            x += gap
    note = "then it ends one of three ways"
    draw.text((x + px(22), mid - line_height(nf, 1.0) // 2), note, font=nf, fill=p.text_muted)

    x = px(PAD)
    for text, why in endings:
        w = pill(x, row2, text, False)
        draw.text((x + w + px(10), row2 + (pill_h - line_height(nf, 1.0)) // 2 - px(1)), why, font=nf, fill=p.text_soft)
        x += w + px(10) + width_of(why, nf) + px(30)
    return image


def figure_family(p: Palette) -> Image.Image:
    relatives = [
        Card("Sara, in the UAE", kicker="Every month", body="$50 from her balance, AUSD", pills=["own mandate", "stops on her own"]),
        Card("Daniel, in the UK", kicker="Just once", body="$25, sent now, settled in the same transaction", pills=["no keeper wait"]),
        Card("Omar, in Saudi Arabia", kicker="Every month", body="$100 from savings, earning until each payment"),
    ]
    recipient = Card("Ammi, in Pakistan", kicker="Recipient", style="ink",
                     body="Opened one support link with her passkey and shared it. Each contribution pays her directly; nobody holds the money on the way.",
                     items=[Item("$150 a month coming in", "about Rs 41,600 at today's rate"), Item("$25 arrived just now", "about Rs 6,940")])
    rate = Card("What it is worth at home", style="soft",
                body="Every amount is shown in the recipient's currency before anyone pays: from Chainlink's fiat feeds on Monad where one exists (EUR, GBP, CAD, CHF, JPY), from a daily market rate otherwise, and the page says which.")
    head_ops, top = header("Family support", "Money home, on time, from everyone.",
                           "One link, many relatives. Every gift is its own capped mandate in Agora's AUSD, so one person stopping never touches another.", p)
    span = px(WIDTH - PAD * 2)
    left_w = int(span * 0.4)
    gutter = px(190)
    right_w = span - left_w - gutter
    heights = [flow(c, left_w, p)[1] for c in relatives]
    left_total = sum(heights) + px(GAP) * (len(relatives) - 1)
    rec_h = flow(recipient, right_w, p)[1]
    rate_h = flow(rate, right_w, p)[1]
    right_total = rec_h + px(GAP) + rate_h
    body_h = max(left_total, right_total)
    image = canvas(top + body_h + px(PAD), p)
    draw_ops(image, head_ops, 0, 0, p)
    corner_mark(image, p)
    y = top + (body_h - left_total) // 2
    centres = []
    for card, h in zip(relatives, heights):
        draw_card(image, card, px(PAD), y, left_w, h, p)
        centres.append(y + h // 2)
        y += h + px(GAP)
    rx = px(PAD) + left_w + gutter
    ry = top + (body_h - right_total) // 2
    draw_card(image, recipient, rx, ry, right_w, rec_h, p)
    draw_card(image, rate, rx, ry + rec_h + px(GAP), right_w, rate_h, p)
    draw = ImageDraw.Draw(image)
    target_y = ry + rec_h // 2
    x_from, x_to = px(PAD) + left_w + px(6), rx - px(6)
    elbow = x_from + (x_to - x_from) * 3 // 10
    for cy in centres:
        draw.line([(x_from, cy), (elbow, cy)], fill=p.accent, width=px(1.6))
        draw.line([(elbow, cy), (elbow, target_y)], fill=p.accent, width=px(1.6))
    arrow(draw, (elbow, target_y), (x_to, target_y), p.accent, dashed=False)
    f = font(9, 500)
    label = "straight to her"
    draw.text((elbow + (x_to - elbow - width_of(label, f)) // 2, target_y - line_height(f) - px(3)), label, font=f, fill=p.text_muted)
    return image


def figure_banner(p: Palette) -> tuple[Image.Image, list[str]]:
    """The opening image: the site's own hero still, with the headline set over it."""
    w, h = px(WIDTH), px(420)
    photo = Image.open(PHOTO).convert("RGB")
    # Zoomed a little and cropped so the glass panel (at 49% of the still) stands at 64% of the
    # banner, clear of the headline.
    zoom = 1.34
    scale = w * zoom / photo.width
    photo = photo.resize((round(photo.width * scale), round(photo.height * scale)), Image.LANCZOS)
    left = max(0, min(photo.width - w, round(photo.width * 0.49 - w * 0.64)))
    top_crop = round(photo.height * 0.42) - h // 2
    photo = photo.crop((left, top_crop, left + w, top_crop + h)).convert("RGBA")
    # A shade from the left and the bottom, so white type stays readable over the sky and the field.
    shade = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    ink = parse_hex(p.ink)
    for x in range(w):
        t = max(0.0, 1 - x / (w * 0.74))
        sd.line([(x, 0), (x, h)], fill=ink + (int(236 * t ** 1.05),))
    photo.alpha_composite(shade)
    bottom = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bottom)
    for y in range(h):
        t = max(0.0, (y - h * 0.55) / (h * 0.45))
        bd.line([(0, y), (w, y)], fill=ink + (int(150 * t),))
    photo.alpha_composite(bottom)

    checks: list[tuple[tuple[int, int, int, int], str, float, float]] = []

    def behind(box: tuple[int, int, int, int], colour: str, large: bool = False) -> None:
        """Record the contrast of `colour` against the lightest pixel behind `box`, before drawing.
        Large text (the 46pt headline) needs 3:1 under WCAG; everything else 4.5:1."""
        region = photo.convert("RGB").crop(box)
        lightest = max(region.get_flattened_data(), key=luminance)
        checks.append((box, colour, contrast(colour, lightest), 3.0 if large else 4.5))

    draw = ImageDraw.Draw(photo)
    x = px(52)
    mark = Image.open(MARK).convert("RGBA").resize((px(34), px(34)), Image.LANCZOS)
    photo.alpha_composite(mark, (x, px(46)))
    wf = font(17, 600)
    draw.text((x + px(46), px(46) + (px(34) - line_height(wf, 1.0)) // 2 - px(1)), "Weir", font=wf, fill=p.surface)
    hf = font(46, 300)
    y = px(118)
    for line in ("Say yes once.", "Pay when it’s due."):
        behind((x, y, x + width_of(line, hf), y + line_height(hf, 1.0)), p.surface, large=True)
        draw.text((x - px(2), y), line, font=hf, fill=p.surface)
        y += line_height(hf, 1.04)
    tf = font(13, 400)
    tag = "Direct debit for digital dollars, live on Monad Mainnet."
    soft = blend(p.surface, p.ink, 0.86)
    behind((x, y + px(10), x + width_of(tag, tf), y + px(10) + line_height(tf, 1.0)), soft)
    draw.text((x, y + px(10)), tag, font=tf, fill=soft)
    y += px(10) + line_height(tf) + px(26)
    pf = font(10, 500)
    px_ = x
    for pill in ("Passkeys", "Earn until charged", "Capped", "Stop in one tap"):
        pw = width_of(pill, pf) + px(24)
        ph = line_height(pf) + px(12)
        layer = Image.new("RGBA", photo.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle((px_, y, px_ + pw, y + ph), radius=ph // 2,
                                                fill=(255, 255, 255, 38), outline=(255, 255, 255, 90), width=px(1))
        photo.alpha_composite(layer)
        draw = ImageDraw.Draw(photo)
        behind((px_ + px(12), y + px(4), px_ + pw - px(12), y + ph - px(4)), p.surface)
        draw.text((px_ + px(12), y + (ph - line_height(pf, 1.0)) // 2 - px(1)), pill, font=pf, fill=p.surface)
        px_ += pw + px(8)

    # Contrast against the photograph actually behind each line of text, sampled before it was drawn.
    problems = []
    for box, colour, ratio, needed in checks:
        mark_ = "ok  " if ratio >= needed else "FAIL"
        print(f"  {mark_} banner {colour} over the photo at {box[:2]}  {ratio:5.2f}:1 (needs {needed}) against its lightest pixel")
        if ratio < needed:
            problems.append(f"banner text at {box[:2]}")

    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=px(26), fill=255)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(photo, (0, 0), mask)
    return out, problems


FIGURES = {
    "flow": figure_flow,
    "architecture": figure_architecture,
    "mandate": figure_mandate,
    "family": figure_family,
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="audit and lay out, write nothing")
    args = parser.parse_args()
    for path in (TOKENS, MARK, PHOTO):
        if not path.is_file():
            print(f"ERROR: {path} is missing.")
            return 2
    p = palette()
    print("Contrast, every text colour on every surface it lands on:")
    problems = audit(p)
    with tempfile.TemporaryDirectory() as cache:
        load_fonts(Path(cache))
        banner, banner_problems = figure_banner(p)
        problems += banner_problems
        if problems:
            print("Not written: " + ", ".join(problems))
            return 1
        images = {"banner": banner, **{name: make(p) for name, make in FIGURES.items()}}
    for name, image in images.items():
        print(f"  {name}.{FORMAT.get(name, 'png')}  {image.width} x {image.height}")
    if args.check:
        return 0
    OUT.mkdir(parents=True, exist_ok=True)
    for name, image in images.items():
        if FORMAT.get(name) == "webp":
            image.save(OUT / f"{name}.webp", quality=88, method=6)
        else:
            image.save(OUT / f"{name}.png", optimize=True)
    print(f"wrote {len(images)} images to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
