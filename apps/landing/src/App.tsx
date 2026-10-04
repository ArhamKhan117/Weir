import gsap from "gsap";
import { Menu, X } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { APP_URL } from "./app-url";
import { ClosingFooter } from "./components/ClosingFooter";
import { CounterSection } from "./components/CounterSection";
import { InsightsSection } from "./components/InsightsSection";
import { LazyVideo } from "./components/LazyVideo";
import { QuoteCarousel } from "./components/QuoteCarousel";
import {
  INTRO_1440_MIN_DEVICE_WIDTH,
  INTRO_VIDEO,
  INTRO_VIDEO_1440,
  INTRO_VIDEO_PORTRAIT,
  PORTRAIT_QUERY,
  RING_VIDEO,
  type VideoSource,
} from "./media";

const SPOTLIGHT_R = 260;
const GRID_CELL = 48;
const SWIPE_THRESHOLD = 40;

/** Wheel deltas (px) that must accumulate at the top before the intro re-locks. */
const UP_RELEASE = 120;
/** Ignore upward wheel for this long after the document lands back at the top,
 *  so trackpad momentum from a fast scroll-up does not snap into the hero. */
const TOP_SETTLE_MS = 400;
const TOP_EPSILON = 2;

/** The intro counts as stalled after this many checks in a row with no progress. */
const STALL_TICK_MS = 500;
const STALL_TICKS = 3;

const SECTION_FEATURES = "features";
const SECTION_STEPS = "start";

const SECTION_WHO = "who";
const SECTION_FAQ = "faq";

type NavItem = { label: string; target?: string; href?: string };

const NAV_ITEMS: NavItem[] = [
  { label: "Why Weir", target: SECTION_FEATURES },
  { label: "How it works", target: SECTION_STEPS },
  { label: "Who it's for", target: SECTION_WHO },
  { label: "FAQ", target: SECTION_FAQ },
];

/**
 * One subscription, start to finish. The point is the three things a mandate
 * promises: a ceiling on what it can ever take, money that stays put until it
 * is due, and a way out that nobody can refuse.
 */
const TRANSCRIPT: { speaker: "you" | "weir"; text: string; emphasis?: boolean }[] = [
  { speaker: "you", text: "subscribe me to Studio Pro" },
  { speaker: "weir", text: "done. $9.99 a month, never more than $119.88." },
  { speaker: "you", text: "has the money left my account?" },
  { speaker: "weir", text: "no. it stays yours until each charge is due." },
  { speaker: "you", text: "and if I want to stop?" },
  { speaker: "weir", text: "one tap. nobody can say no.", emphasis: true },
];

/**
 * Four columns at 1636px: 384px columns with a 20px gap, a hairline rule above
 * each, and a 384x350 card below holding a 150px icon and its number.
 */
const PILLARS: { title: string; blurb: string; src: string }[] = [
  {
    title: "Your face is the key",
    blurb: "A passkey signs every yes. No seed phrase, no wallet app",
    src: "/media/icon-passkey.webp",
  },
  {
    title: "Three hard limits",
    blurb: "Per charge, per period and in total, enforced on chain",
    src: "/media/icon-limits.webp",
  },
  {
    title: "Charged when due",
    blurb: "Anyone can collect a charge on time. Nobody can collect it early",
    src: "/media/icon-network.webp",
  },
  {
    title: "Stopped in one tap",
    blurb: "Pause or cancel at once, and nobody can refuse",
    src: "/media/icon-stop.webp",
  },
];

/** The Weir mark, the same file the app uses as its icon. */
const LOGO_SRC = "/logo.svg";

const STAGGER_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Shared horizontal rhythm for the unlocked content below the intro. */
const GUTTER = "px-5 sm:px-10 md:px-14";
const CONTAINER = "mx-auto w-full";
const WIDE = "max-w-5xl";

const EYEBROW = "text-[11px] uppercase tracking-[0.2em] text-[#18161B]/45";

type VideoPhase = "idle" | "playing" | "done";

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "start",
  });
}

/** One-shot in-view flag; drives the shared `.anim-stagger` entrance. */
function useInView<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, inView];
}

function Reveal({
  delay = 0,
  className = "",
  children,
}: {
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className={`${inView ? "anim-stagger" : "opacity-0"} ${className}`}
      style={{ animationDelay: `${delay}s` }}
    >
      {children}
    </div>
  );
}

/** `image` is one of the `.img-*` classes in index.css, which carry the AVIF and WebP pair. */
function RevealLayer({ image }: { image: string }) {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;

    const size = SPOTLIGHT_R * 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const gradient = ctx.createRadialGradient(
      SPOTLIGHT_R,
      SPOTLIGHT_R,
      0,
      SPOTLIGHT_R,
      SPOTLIGHT_R,
      SPOTLIGHT_R,
    );
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.4, "rgba(255,255,255,1)");
    gradient.addColorStop(0.6, "rgba(255,255,255,0.75)");
    gradient.addColorStop(0.75, "rgba(255,255,255,0.4)");
    gradient.addColorStop(0.88, "rgba(255,255,255,0.12)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const maskUrl = `url(${canvas.toDataURL()})`;
    el.style.setProperty("mask-image", maskUrl);
    el.style.setProperty("-webkit-mask-image", maskUrl);
    el.style.setProperty("mask-repeat", "no-repeat");
    el.style.setProperty("-webkit-mask-repeat", "no-repeat");

    // Start far offscreen so nothing is revealed until the cursor moves.
    const mouse = { x: -SPOTLIGHT_R * 4, y: -SPOTLIGHT_R * 4 };
    const smooth = { x: mouse.x, y: mouse.y };
    let raf = 0;

    const onMouseMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    };

    const tick = () => {
      smooth.x += (mouse.x - smooth.x) * 0.1;
      smooth.y += (mouse.y - smooth.y) * 0.1;
      const pos = `${smooth.x - SPOTLIGHT_R}px ${smooth.y - SPOTLIGHT_R}px`;
      el.style.setProperty("mask-position", pos);
      el.style.setProperty("-webkit-mask-position", pos);
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("mousemove", onMouseMove);
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return <div ref={layerRef} className={`absolute inset-0 bg-cover bg-center ${image}`} />;
}

function HeroSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const patternRef = useRef<SVGPatternElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    const pattern = patternRef.current;
    if (!section || !pattern) return;

    const target = { x: 0, y: 0 };
    const offset = { x: 0, y: 0 };
    let raf = 0;

    const onMouseMove = (e: MouseEvent) => {
      const rect = section.getBoundingClientRect();
      const cx = (e.clientX - rect.left) / rect.width - 0.5;
      const cy = (e.clientY - rect.top) / rect.height - 0.5;
      target.x = cx * 16;
      target.y = cy * 16;
    };

    const tick = () => {
      offset.x += (target.x - offset.x) * 0.06;
      offset.y += (target.y - offset.y) * 0.06;
      pattern.setAttribute("x", String(offset.x));
      pattern.setAttribute("y", String(offset.y));
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("mousemove", onMouseMove);
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section
      ref={sectionRef}
      className="font-helvetica-neue relative h-screen w-full overflow-clip"
    >
      <svg aria-hidden="true" className="absolute inset-0 h-full w-full" style={{ opacity: 0.08 }}>
        <defs>
          <pattern
            ref={patternRef}
            id="hero-grid"
            width={GRID_CELL}
            height={GRID_CELL}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${GRID_CELL} 0 L 0 0 0 ${GRID_CELL}`}
              fill="none"
              stroke="#94a3b8"
              strokeWidth="0.5"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#hero-grid)" />
      </svg>

      <div
        className="anim-fade img-hero-frame absolute inset-0 bg-cover bg-center"
        style={{ animationDelay: "0.1s" }}
      />

      <RevealLayer image="img-hero-glow" />

      <div className="absolute inset-x-0 bottom-0 z-40 h-72 bg-gradient-to-t from-[#0A0B11] via-[#0A0B11]/60 to-transparent" />

      <div className="absolute inset-x-0 bottom-0 z-50 grid gap-10 px-6 pb-12 sm:px-10 sm:pb-16 md:grid-cols-12 md:items-end md:px-14 md:pb-20">
        <div className="md:col-span-7 lg:col-span-8">
          <h1
            className="anim-stagger font-light text-white"
            style={{
              animationDelay: "0.5s",
              fontSize: "clamp(2.2rem, 6.5vw, 5rem)",
              lineHeight: 0.95,
              letterSpacing: "-0.03em",
            }}
          >
            Say Yes Once
            <br />
            Pay When It&rsquo;s Due
          </h1>
        </div>

        <div
          className="anim-stagger md:col-span-5 lg:col-span-4"
          style={{ animationDelay: "0.85s" }}
        >
          <p className="max-w-md text-[15px] leading-relaxed text-white/75 sm:text-base">
            Direct debit for digital dollars. Approve a plan with your face or fingerprint, cap what
            it can ever take, and keep the money in your own account until each charge is due. Stop
            it in one tap, any time.
          </p>
        </div>
      </div>
    </section>
  );
}

function CardSection({ visible, imagesVisible }: { visible: boolean; imagesVisible: boolean }) {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    setInView(visible);
  }, [visible]);

  const h2Style = {
    fontSize: "clamp(2rem, 7vw, 5.5rem)",
    lineHeight: 0.95,
    letterSpacing: "-0.03em",
  };

  const staggerClass = (base: string) => `${base} ${inView ? "anim-stagger" : "opacity-0"}`;

  return (
    <section
      className={`absolute inset-0 z-[1] h-screen overflow-hidden transition-opacity duration-700 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span
          className="font-medium uppercase text-white/[0.04]"
          style={{ fontSize: "clamp(4rem, 15vw, 14rem)", letterSpacing: "-0.02em" }}
        >
          WEIR
        </span>
      </div>

      <div
        className={`absolute inset-0 transition-opacity duration-700 ${
          imagesVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        {/* The base is the intro's last frame, so the handoff from the video is invisible; the
            spotlight shows the same tile with the water risen over it. */}
        <div className="img-tile-water absolute inset-0 bg-cover bg-center" />
        <RevealLayer image="img-tile-flood" />
      </div>

      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-4 px-5 pt-16 sm:px-10 sm:pt-28 md:px-14 md:pt-32">
        <h2
          className={staggerClass("font-light text-[#18161B]")}
          style={{ ...h2Style, animationDelay: "0.15s" }}
        >
          It Takes What&rsquo;s Due
        </h2>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-8 px-5 pb-10 sm:px-10 sm:pb-14 md:flex-row md:items-end md:justify-between md:px-14 md:pb-16">
        <div className={staggerClass("max-w-md")} style={{ animationDelay: "0.7s" }}>
          <p className="text-[15px] leading-relaxed text-[#18161B]/75 sm:text-base">
            A mandate is a yes with its limits written in: how much a charge can be, how often, and
            how much in total. Your dollars stay in your account until the day each one is due.
          </p>
        </div>
        <h2
          className={staggerClass("font-light text-[#18161B] md:text-right")}
          style={{ ...h2Style, animationDelay: "0.5s" }}
        >
          Never A Cent More
        </h2>
      </div>
    </section>
  );
}

/**
 * Types the transcript out on a GSAP timeline the first time it scrolls into
 * view. A pause before each card reply makes the exchange read as a
 * conversation rather than as text appearing. It plays once, because a transcript
 * loops forever competes with the prose around it.
 */
function useTypedTranscript(active: boolean) {
  const [typed, setTyped] = useState<string[]>(() => TRANSCRIPT.map(() => ""));
  const [typingIndex, setTypingIndex] = useState(-1);
  const [visibleCount, setVisibleCount] = useState(-1);
  const [thinking, setThinking] = useState(false);
  const played = useRef(false);

  useEffect(() => {
    if (!active || played.current) return;
    played.current = true;

    if (prefersReducedMotion()) {
      setTyped(TRANSCRIPT.map((e) => e.text));
      setVisibleCount(TRANSCRIPT.length);
      return;
    }

    const tl = gsap.timeline();

    TRANSCRIPT.forEach((entry, i) => {
      // Weir pauses before answering; you do not pause before your own line.
      if (entry.speaker === "weir") {
        tl.call(() => setThinking(true));
        tl.to({}, { duration: 0.55 });
        tl.call(() => setThinking(false));
      }

      const counter = { n: 0 };
      tl.call(() => {
        setVisibleCount(i);
        setTypingIndex(i);
      });
      tl.to(counter, {
        n: entry.text.length,
        duration: Math.min(1.5, 0.22 + entry.text.length * 0.016),
        ease: "none",
        onUpdate: () => {
          const n = Math.round(counter.n);
          setTyped((prev) => {
            if (prev[i]?.length === n) return prev;
            const next = [...prev];
            next[i] = entry.text.slice(0, n);
            return next;
          });
        },
      });
      tl.to({}, { duration: 0.28 });
    });

    tl.call(() => setTypingIndex(-1));

    return () => {
      tl.kill();
    };
  }, [active]);

  return { typed, typingIndex, visibleCount, thinking };
}

function ChatDemoSection() {
  const [ref, inView] = useInView<HTMLDivElement>();
  const { typed, typingIndex, thinking } = useTypedTranscript(inView);

  return (
    <section
      ref={ref}
      className={`${GUTTER} flex min-h-screen scroll-mt-24 items-center bg-[#F4F0ED] py-24`}
    >
      <div className={`${CONTAINER} ${WIDE}`}>
        <div className="flex flex-col gap-4 sm:gap-6">
          {TRANSCRIPT.map((entry, i) => {
            const isYou = entry.speaker === "you";
            const startsRun = i === 0 || TRANSCRIPT[i - 1]?.speaker !== entry.speaker;
            const shown = typed[i] ?? "";
            const started = shown.length > 0 || i === typingIndex;

            return (
              <div
                key={entry.text}
                className={`flex flex-col ${isYou ? "items-start" : "items-end"}`}
              >
                {startsRun && (
                  <span
                    className={`mb-2 px-3 text-xs text-[#18161B]/40 transition-opacity duration-300 sm:text-sm ${
                      started ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    {isYou ? "You:" : "Weir:"}
                  </span>
                )}
                {/*
                  Every bubble is laid out from the start and only faded in, so
                  the section's height never changes while the transcript types.
                  Rendering them as they arrive made the background grow.
                */}
                <div
                  className={`max-w-full rounded-[1.75rem] px-6 py-3 transition-opacity duration-300 sm:rounded-full sm:px-8 sm:py-4 ${
                    started ? "opacity-100" : "opacity-0"
                  } ${
                    isYou ? "bg-[#18161B]/[0.06] text-[#18161B]" : "bg-[#18161B] text-[#F4F0ED]"
                  }`}
                  style={{
                    fontSize: "clamp(1.05rem, 2.4vw, 1.75rem)",
                    lineHeight: 1.2,
                    letterSpacing: "-0.02em",
                  }}
                >
                  <span className="font-light">{shown || entry.text}</span>
                  {i === typingIndex && (
                    <span className="ml-1 inline-block h-[0.7em] w-[0.055em] animate-pulse bg-current align-middle" />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-10 flex h-3 items-center justify-end gap-1.5 pr-6">
          {thinking &&
            [0, 1, 2].map((d) => (
              <span
                key={d}
                className="h-2 w-2 animate-pulse rounded-full bg-[#18161B]/40"
                style={{ animationDelay: `${d * 0.15}s` }}
              />
            ))}
        </div>
      </div>
    </section>
  );
}

/**
 * A full-viewport section, copy in the top-left corner, and the product shot
 * absolutely placed at `right: 0; bottom: 0` occupying 74% of the width. The
 * image sits flush to the right edge rather than bleeding past it. Positioning is
 * against the section, not the centred `max-w-5xl` container the rest of the page
 * uses, which is what puts the copy in the corner. Below `md` it all returns to
 * normal flow.
 */
function SpendSection() {
  return (
    <section className="relative overflow-hidden py-16 sm:py-24 md:min-h-screen md:pb-0 md:pt-[120px]">
      <div className={GUTTER}>
        <div className="relative z-[1] max-w-3xl">
          <Reveal>
            <h2
              className="font-light text-[#18161B]"
              style={{
                fontSize: "clamp(2.1rem, 6vw, 4.25rem)",
                lineHeight: 0.98,
                letterSpacing: "-0.03em",
              }}
            >
              Pay the plan.
              <br />
              Keep the money.
            </h2>
          </Reveal>

          {/* Wide enough that the sentence lands on two lines, never three. */}
          <Reveal delay={0.08}>
            <p className="mt-[30px] text-[15px] leading-relaxed text-[#18161B]/60 sm:text-base">
              Nothing is paid up front and nothing sits with Weir. Your dollars stay in your own
              account, or keep earning in savings, until the moment each charge is due.
            </p>
          </Reveal>
        </div>
      </div>

      {/* A plain picture, not next/image: it must paint the moment the section appears. */}
      <picture>
        <source
          type="image/avif"
          srcSet="/media/spend-1200.avif 1200w, /media/spend.avif 2424w"
          sizes="(min-width: 768px) 74vw, 100vw"
        />
        <img
          src="/media/spend.webp"
          alt="A hand holding a phone that shows Weir: subscribed to Studio Pro at $9.99 a month, never more than $119.88"
          width={2424}
          height={1700}
          loading="lazy"
          decoding="async"
          className="mt-12 w-full px-5 sm:px-10 md:absolute md:bottom-0 md:right-0 md:mt-0 md:w-[74%] md:px-0"
        />
      </picture>
    </section>
  );
}

/**
 * Full-bleed looping ring: the section is a centring flex box, the video runs at
 * 100% width with `object-fit: contain` so the section's height follows the
 * footage, and the copy sits centred on top of it. Family support is the use
 * this stands for: one mandate per relative, sending money home every month.
 */
function ReachSection() {
  return (
    // The clip lives on the wrapper, not the section: the video carries its own
    // near-white background, and rounding that band is what stops it meeting the
    // page colour on a hard horizontal line.
    <section className="relative my-16 flex items-center justify-center overflow-hidden rounded-[40px] md:my-28 md:rounded-[72px]">
      <LazyVideo
        sources={RING_VIDEO}
        poster="/media/ring-poster.jpg"
        // On a phone the ring is drawn wider than the screen, so the headline sits inside its
        // hole instead of across the flags; the section's flex centring crops it evenly.
        className="aspect-[1920/1500] w-[170%] max-w-none shrink-0 object-contain sm:w-[130%] md:w-full"
      />

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
        <Reveal>
          <p className="text-[12px] font-medium uppercase tracking-[0.5px] text-[#18161B]/45">
            Family support, across borders
          </p>
        </Reveal>
        <Reveal delay={0.08}>
          <h2
            className="mt-4 font-light text-[#18161B]"
            style={{
              fontSize: "clamp(1.9rem, 5.2vw, 3.75rem)",
              lineHeight: 1,
              letterSpacing: "-0.03em",
            }}
          >
            Send money home.
            <br />
            Every month.
          </h2>
        </Reveal>
      </div>
    </section>
  );
}

function FeaturesSection() {
  return (
    <section id={SECTION_FEATURES} className={`${GUTTER} scroll-mt-24 py-16 sm:py-24`}>
      <Reveal>
        <p className={EYEBROW}>Built to be checked</p>
      </Reveal>

      <Reveal delay={0.08}>
        <h2
          className="mt-5 max-w-3xl text-balance font-light text-[#18161B]"
          style={{
            fontSize: "clamp(2.1rem, 6vw, 4.25rem)",
            lineHeight: 0.98,
            letterSpacing: "-0.03em",
          }}
        >
          What a mandate actually does
        </h2>
      </Reveal>

      {/* 384px columns, 20px gutter, exactly as the reference lays them out. */}
      <div className="mt-12 grid gap-5 sm:mt-16 sm:grid-cols-2 lg:grid-cols-4">
        {PILLARS.map((pillar, i) => (
          <Reveal key={pillar.title} delay={0.12 + i * 0.08}>
            <div className="border-t border-[#18161B]/15 pt-5">
              <h3 className="text-[15px] font-semibold text-[#18161B]">{pillar.title}</h3>
              <p className="mt-1.5 text-[15px] leading-snug text-[#18161B]/45">{pillar.blurb}</p>
            </div>

            <div className="relative mt-6 aspect-[384/350] rounded-2xl bg-white">
              <img
                src={pillar.src}
                alt=""
                aria-hidden
                width={400}
                height={400}
                loading="lazy"
                decoding="async"
                className="absolute inset-0 m-auto w-[39%] object-contain"
              />
              <span className="font-code absolute bottom-5 left-5 text-[12px] text-[#18161B]/35">
                {`0${i + 1}`}
              </span>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function Content() {
  return (
    <main className="relative z-[4] overflow-hidden rounded-t-[40px] bg-[#F4F0ED] md:rounded-t-[72px]">
      <ChatDemoSection />
      <SpendSection />
      <ReachSection />
      <FeaturesSection />
      <InsightsSection id={SECTION_STEPS} />
      <CounterSection />
      <QuoteCarousel id={SECTION_WHO} />
      <ClosingFooter logoSrc={LOGO_SRC} faqId={SECTION_FAQ} />
    </main>
  );
}

function Nav({
  dark,
  activeTarget,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onNavigate,
}: {
  dark: boolean;
  activeTarget: string;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onNavigate: (id: string) => void;
}) {
  // The mobile panel is near-black, so keep nav chrome white while it is open.
  const d = dark && !menuOpen;

  const itemProps = (item: NavItem) =>
    item.href
      ? { href: item.href, target: "_blank", rel: "noreferrer" as const }
      : {
          href: `#${item.target}`,
          onClick: (e: ReactMouseEvent) => {
            e.preventDefault();
            onNavigate(item.target!);
          },
        };

  const isActive = (item: NavItem) => Boolean(item.target) && item.target === activeTarget;

  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        tabIndex={menuOpen ? 0 : -1}
        className={`fixed inset-0 z-[54] bg-black/60 backdrop-blur-sm transition-opacity duration-300 md:hidden ${
          menuOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onCloseMenu}
      />

      <div
        className={`fixed inset-x-0 top-0 z-[55] bg-[#0A0B11]/[0.98] px-5 pb-8 pt-20 transition-transform duration-500 md:hidden ${
          menuOpen ? "translate-y-0" : "-translate-y-full"
        }`}
        style={{ transitionTimingFunction: STAGGER_EASE }}
      >
        <nav className="flex flex-col">
          {NAV_ITEMS.map((item, i) => (
            <a
              key={item.label}
              {...itemProps(item)}
              className={`py-3 text-lg transition-all duration-400 ${
                isActive(item) ? "text-white" : "text-white/70"
              } ${menuOpen ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"}`}
              style={{
                transitionDelay: menuOpen ? `${80 + i * 40}ms` : "0ms",
                transitionTimingFunction: STAGGER_EASE,
              }}
            >
              {item.label}
            </a>
          ))}
          <div
            className={`mt-6 flex items-center gap-3 transition-all duration-400 ${
              menuOpen ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
            }`}
            style={{
              transitionDelay: menuOpen ? "300ms" : "0ms",
              transitionTimingFunction: STAGGER_EASE,
            }}
          >
            <a
              href={APP_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-white px-5 py-2.5 text-sm font-medium text-gray-900 no-underline"
            >
              Open Weir
            </a>
          </div>
        </nav>
      </div>

      <header className="fixed inset-x-0 top-0 z-[60] flex items-center justify-between px-5 py-4 sm:px-8 sm:py-5 md:px-10">
        <div className="flex items-center gap-2.5">
          <img
            src={LOGO_SRC}
            alt=""
            width={24}
            height={24}
            className="h-6 w-6 shrink-0 object-contain"
            aria-hidden
          />
          <span
            className={`text-sm font-medium uppercase tracking-wide transition-colors duration-500 ${
              d ? "text-[#18161B]" : "text-white"
            }`}
          >
            Weir
          </span>
        </div>

        <nav className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center rounded-full px-1.5 py-1.5 md:flex">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.label}
              {...itemProps(item)}
              className={`rounded-full px-4 py-2 text-sm transition-colors duration-500 ${
                isActive(item)
                  ? d
                    ? "bg-[#18161B] text-white"
                    : "bg-white text-gray-900"
                  : d
                    ? "text-[#18161B]/70 hover:text-[#18161B]"
                    : "text-white/70 hover:text-white"
              }`}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <a
            href={APP_URL}
            target="_blank"
            rel="noreferrer"
            className={`rounded-full px-5 py-2.5 text-sm font-medium no-underline transition-colors duration-500 ${
              d ? "bg-[#18161B] text-white" : "bg-white text-gray-900"
            }`}
          >
            Open Weir
          </a>
        </div>

        <button
          type="button"
          className={`relative flex h-10 w-10 items-center justify-center transition-colors duration-500 md:hidden ${
            d ? "text-[#18161B]" : "text-white"
          }`}
          onClick={onToggleMenu}
          aria-label="Toggle menu"
        >
          <Menu
            size={22}
            className={`absolute transition-all duration-300 ${
              menuOpen ? "rotate-90 opacity-0" : "rotate-0 opacity-100"
            }`}
          />
          <X
            size={22}
            className={`absolute transition-all duration-300 ${
              menuOpen ? "rotate-0 opacity-100" : "-rotate-90 opacity-0"
            }`}
          />
        </button>
      </header>
    </>
  );
}

export default function App() {
  const [videoPhase, setVideoPhase] = useState<VideoPhase>("idle");
  const [sectionVisible, setSectionVisible] = useState(false);
  const [imagesVisible, setImagesVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeTarget, setActiveTarget] = useState(SECTION_FEATURES);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingScroll = useRef<string | null>(null);
  // Chosen once the page knows the screen's shape. The server render has no screen, so the video
  // starts with no sources and loads whichever cut fits as soon as it mounts.
  const [introSources, setIntroSources] = useState<VideoSource[]>([]);

  useEffect(() => {
    if (window.matchMedia(PORTRAIT_QUERY).matches) setIntroSources(INTRO_VIDEO_PORTRAIT);
    else if (window.innerWidth * window.devicePixelRatio > INTRO_1440_MIN_DEVICE_WIDTH)
      setIntroSources(INTRO_VIDEO_1440);
    else setIntroSources(INTRO_VIDEO);
  }, []);

  // `done` is also the unlocked state: the content below the intro only exists
  // then, so while the intro is playing the document is exactly one viewport
  // tall and cannot scroll at all.
  const unlocked = videoPhase === "done";

  /** The intro is over, however it ended: the stills take its place and the page unlocks. */
  const finishIntro = useCallback(() => {
    setVideoPhase("done");
    setSectionVisible(true);
    setImagesVisible(true);
  }, []);

  const startVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    // Reduced motion skips the film and lands on where it ends.
    if (prefersReducedMotion()) {
      finishIntro();
      return;
    }
    setVideoPhase("playing");
    setSectionVisible(false);
    setImagesVisible(false);
    video.muted = true;
    video.currentTime = 0;
    // A refused play (iOS Low Power Mode blocks even muted video) must not strand the visitor on
    // an empty screen with the scroll locked.
    void video.play().catch(finishIntro);
  }, [finishIntro]);

  // The same for a film that starts and then stops moving: a stalled network, or a browser that
  // pauses video it decides nobody is watching. Once playback stops advancing, finish.
  useEffect(() => {
    if (videoPhase !== "playing") return;
    const video = videoRef.current;
    if (!video) return;
    let last = -1;
    let still = 0;
    const timer = window.setInterval(() => {
      if (video.currentTime === last) still += 1;
      else still = 0;
      last = video.currentTime;
      if (still >= STALL_TICKS) finishIntro();
    }, STALL_TICK_MS);
    return () => window.clearInterval(timer);
  }, [videoPhase, finishIntro]);

  const resetToHero = useCallback(() => {
    const video = videoRef.current;
    setVideoPhase("idle");
    setSectionVisible(false);
    setImagesVisible(false);
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
  }, []);

  /** Jump past the cinematic intro without playing it (nav clicks). */
  const releaseLock = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    setVideoPhase("done");
    setSectionVisible(true);
    setImagesVisible(true);
  }, []);

  const goToSection = useCallback(
    (id: string) => {
      setMenuOpen(false);
      if (videoPhase === "done") {
        // Defer a frame so a closing mobile menu settles before the scroll.
        requestAnimationFrame(() => scrollToSection(id));
        return;
      }
      pendingScroll.current = id;
      releaseLock();
    },
    [videoPhase, releaseLock],
  );

  // Scroll requested while the intro was still locked: the target only mounts
  // once `done` renders, so run it on the next frame after that commit.
  useEffect(() => {
    if (!unlocked || !pendingScroll.current) return;
    const id = pendingScroll.current;
    pendingScroll.current = null;
    const raf = requestAnimationFrame(() => scrollToSection(id));
    return () => cancelAnimationFrame(raf);
  }, [unlocked]);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  // The active nav item follows the document scroll once unlocked.
  useEffect(() => {
    if (!unlocked) {
      setActiveTarget(SECTION_FEATURES);
      return;
    }
    let raf = 0;
    const targets = NAV_ITEMS.flatMap((item) => (item.target ? [item.target] : []));
    const update = () => {
      raf = 0;
      // The last section whose top has passed under the nav, or the last of all once the page
      // is scrolled to the end, where the FAQ can never reach the top.
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let active = targets[0] ?? SECTION_FEATURES;
      for (const id of targets) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= 240) active = id;
      }
      setActiveTarget(atEnd ? (targets[targets.length - 1] ?? active) : active);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [unlocked]);

  useEffect(() => {
    // Upward intent accumulated while the document is pinned at the top.
    let upAccum = 0;
    let leftTopAt = 0;

    const onWheel = (e: WheelEvent) => {
      if (videoPhase === "idle") {
        if (e.deltaY > 0) startVideo();
        return;
      }
      if (videoPhase !== "done") return;
      if (e.deltaY >= 0) {
        upAccum = 0;
        return;
      }
      if (window.scrollY > TOP_EPSILON) {
        upAccum = 0;
        leftTopAt = performance.now();
        return;
      }
      // Let momentum from the scroll that brought us here die out first.
      if (performance.now() - leftTopAt < TOP_SETTLE_MS) return;
      upAccum += -e.deltaY;
      if (upAccum >= UP_RELEASE) {
        upAccum = 0;
        resetToHero();
      }
    };

    let touchStartY = 0;
    let touchStartScroll = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
      touchStartScroll = window.scrollY;
    };
    const onTouchEnd = (e: TouchEvent) => {
      // Positive delta = swipe up (finger moved toward the top of the screen).
      const delta = touchStartY - e.changedTouches[0].clientY;
      if (delta > SWIPE_THRESHOLD && videoPhase === "idle") startVideo();
      else if (
        delta < -SWIPE_THRESHOLD &&
        videoPhase === "done" &&
        touchStartScroll <= TOP_EPSILON &&
        window.scrollY <= TOP_EPSILON
      )
        resetToHero();
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [videoPhase, startVideo, resetToHero]);

  const navDark = videoPhase === "done" || sectionVisible;

  return (
    <div className="relative min-h-screen overflow-x-clip bg-[#F4F0ED]">
      <div className="relative h-screen overflow-hidden">
        <CardSection visible={sectionVisible} imagesVisible={imagesVisible} />

        <video
          ref={videoRef}
          muted
          playsInline
          preload="auto"
          onTimeUpdate={(e) => {
            if (videoPhase === "playing" && e.currentTarget.currentTime >= 2) {
              setSectionVisible(true);
            }
          }}
          onEnded={finishIntro}
          className={`pointer-events-none fixed inset-0 z-[2] h-full w-full object-cover transition-opacity duration-500 ${
            videoPhase === "playing" ? "opacity-100" : "opacity-0"
          }`}
        >
          {introSources.map((source) => (
            <source key={source.src} src={source.src} type={source.type} />
          ))}
        </video>

        <div
          className={`absolute inset-0 z-[3] transition-opacity duration-700 ${
            videoPhase !== "idle" ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          <HeroSection />
        </div>
      </div>

      {unlocked && <Content />}

      <Nav
        dark={navDark}
        activeTarget={activeTarget}
        menuOpen={menuOpen}
        onToggleMenu={() => setMenuOpen((v) => !v)}
        onCloseMenu={() => setMenuOpen(false)}
        onNavigate={goToSection}
      />
    </div>
  );
}
