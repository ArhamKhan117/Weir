import {
  Bot,
  ChevronLeft,
  ChevronRight,
  HeartHandshake,
  type LucideIcon,
  PiggyBank,
  Repeat,
  Store,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useInViewAnimation } from "../hooks/useInViewAnimation";

/**
 * Who a mandate is for, one card each. Deliberately not testimonials: there are
 * no customers to quote yet, and an invented person vouching for a payments
 * product is the one thing this page must not do. Each card says what that kind
 * of user gets, in Weir's voice, under the name of the role.
 */
const QUOTES: {
  quote: string;
  role: string;
  detail: string;
  icon: LucideIcon;
}[] = [
  {
    quote:
      "Subscribe to the things you use without handing anyone your card. Every plan has a ceiling, and stopping is one tap.",
    role: "Subscribers",
    detail: "Plans billed by the period or by the second",
    icon: Repeat,
  },
  {
    quote:
      "Share a checkout link and get paid in dollars when each charge is due. No chasing, no card network taking a cut.",
    role: "Businesses",
    detail: "Plans, payouts and webhooks",
    icon: Store,
  },
  {
    quote:
      "Send money home every month from anywhere. Relatives chip in to one support circle, and every payment is capped.",
    role: "Families abroad",
    detail: "Support circles",
    icon: HeartHandshake,
  },
  {
    quote:
      "Let an agent subscribe for you inside a limit it cannot pass. It signs; it never holds a cent of your money.",
    role: "AI agents",
    detail: "A MetaMask Agent Wallet plugin",
    icon: Bot,
  },
  {
    quote:
      "Keep your dollars earning in savings until the day a charge is due, then pay it straight from there.",
    role: "Savers",
    detail: "Earn until charged",
    icon: PiggyBank,
  },
];

/** Tripled so the track can wrap without a visible jump. Keys are assigned
 *  here rather than from the render index, which would not be stable. */
const CAROUSEL = [0, 1, 2].flatMap((copy) =>
  QUOTES.map((entry, position) => ({ ...entry, key: `${copy}-${position}` })),
);

const GAP = 24;
const DESKTOP_CARD = 427.5;

export function QuoteCarousel({ id }: { id?: string }) {
  const { ref, isInView } = useInViewAnimation<HTMLElement>();
  // Position is an index, not pixels. It starts on the middle copy so stepping
  // either way always has a real card to move onto.
  const [index, setIndex] = useState(QUOTES.length);
  const [isPaused, setIsPaused] = useState(false);
  // Turned off for one frame while the track jumps between identical copies.
  const [animate, setAnimate] = useState(true);
  // Measured after mount: this page is prerendered, so `window` is not there yet.
  const [cardWidth, setCardWidth] = useState(DESKTOP_CARD);

  useEffect(() => {
    const measure = () =>
      setCardWidth(window.innerWidth < 768 ? window.innerWidth - 48 : DESKTOP_CARD);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const cardWithGap = cardWidth + GAP;
  const step = useCallback((direction: 1 | -1) => setIndex((current) => current + direction), []);

  /**
   * Runs when the slide has finished moving, never mid-flight. If the track has
   * walked off the middle copy, put it back on the equivalent card with the
   * transition off. The copies are identical, so nothing moves on screen.
   */
  const normalise = useCallback(() => {
    setIndex((current) => {
      const wrapped =
        QUOTES.length +
        ((((current - QUOTES.length) % QUOTES.length) + QUOTES.length) % QUOTES.length);
      if (wrapped !== current) setAnimate(false);
      return wrapped;
    });
  }, []);

  // Re-arm the transition a frame after a snap. Depending on `animate` alone is
  // what matters: keying this on the index would let the effect cancel its own
  // frame the moment the index changed, and the transition would never return.
  useEffect(() => {
    if (animate) return;
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, [animate]);

  useEffect(() => {
    if (isPaused) return;
    const timer = window.setInterval(() => step(1), 3000);
    return () => window.clearInterval(timer);
  }, [isPaused, step]);

  const reveal = (delay: string) => ({
    className: isInView ? "animate-fade-in-up" : "opacity-0",
    style: { animationDelay: isInView ? delay : "0s" },
  });

  const heading = reveal("0.1s");
  const aside = reveal("0.2s");
  const track = reveal("0.3s");
  const controls = reveal("0.4s");

  return (
    <section ref={ref} id={id} className="w-full scroll-mt-24 bg-white py-20">
      <div className="mx-auto max-w-[1260px] px-6">
        <div className="w-full">
          <div className="mb-14 flex flex-col gap-6 md:flex-row md:items-start md:justify-between md:gap-0">
            <h2
              className={`flex-1 text-[32px] font-normal leading-[1.1] tracking-tight text-[#0D212C] md:text-[40px] lg:text-[44px] ${heading.className}`}
              style={heading.style}
            >
              Who it&rsquo;s{" "}
              <span className="font-serif italic" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
                for
              </span>
            </h2>

            <p
              className={`max-w-[300px] text-base text-[#273C46] md:text-right ${aside.className}`}
              style={aside.style}
            >
              One kind of payment, a yes with limits, for everyone who pays on a schedule
            </p>
          </div>

          <section
            aria-label="Who Weir is for"
            className={`relative -mx-6 overflow-hidden py-6 md:mx-0 ${track.className}`}
            style={track.style}
            onMouseEnter={() => setIsPaused(true)}
            onMouseLeave={() => setIsPaused(false)}
            onFocus={() => setIsPaused(true)}
            onBlur={() => setIsPaused(false)}
          >
            <div
              className="flex gap-6 pl-6 md:pl-0"
              onTransitionEnd={normalise}
              style={{
                transform: `translateX(-${index * cardWithGap}px)`,
                transition: animate ? "transform 0.8s cubic-bezier(0.4, 0, 0.2, 1)" : "none",
              }}
            >
              {CAROUSEL.map((entry, position) => {
                // Cards leaving on the left fade and shrink rather than clipping.
                const relative = (position - index) * cardWithGap;
                let opacity = 1;
                let scale = 1;
                if (relative < -cardWidth / 2) {
                  const exit = Math.min(1, Math.abs(relative) / cardWidth);
                  opacity = Math.max(0, 1 - exit * 2);
                  scale = Math.max(0.85, 1 - exit * 0.15);
                }

                const Icon = entry.icon;
                return (
                  <article
                    key={entry.key}
                    className="flex flex-shrink-0 flex-col justify-between rounded-[32px] bg-white px-6 py-8 shadow-[0_4px_16px_rgba(0,0,0,0.08)] md:rounded-[40px] md:pb-[2.63rem] md:pl-10 md:pr-24 md:pt-[2.36rem]"
                    style={{
                      width: `${cardWidth}px`,
                      opacity,
                      transform: `scale(${scale})`,
                      transition: "opacity 0.4s ease-out, transform 0.4s ease-out",
                    }}
                  >
                    <p className="mb-8 text-base leading-relaxed text-[#0D212C]">{entry.quote}</p>

                    <div className="flex items-center gap-4">
                      <span
                        aria-hidden
                        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#E3F1EE] text-[#0E6E64]"
                      >
                        <Icon className="h-5 w-5" strokeWidth={1.8} />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-[#0D212C]">{entry.role}</p>
                        <p className="flex items-center gap-1 text-sm text-[#273C46]">
                          <span className="text-xs">↳</span>
                          <span>{entry.detail}</span>
                        </p>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <div className={`mt-8 flex gap-4 ${controls.className}`} style={controls.style}>
            <button
              type="button"
              aria-label="Previous"
              onClick={() => step(-1)}
              className="flex h-12 w-12 items-center justify-center rounded-full border border-[#0D212C]/20 transition-colors hover:bg-[#0D212C]/5"
            >
              <ChevronLeft className="h-5 w-5 text-[#0D212C]" />
            </button>
            <button
              type="button"
              aria-label="Next"
              onClick={() => step(1)}
              className="flex h-12 w-12 items-center justify-center rounded-full border border-[#0D212C]/20 transition-colors hover:bg-[#0D212C]/5"
            >
              <ChevronRight className="h-5 w-5 text-[#0D212C]" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
