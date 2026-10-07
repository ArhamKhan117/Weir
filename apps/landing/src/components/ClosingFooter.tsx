import gsap from "gsap";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { APP_URL } from "../app-url";

const X_URL = "https://x.com/weirstudio";

function XLogo({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const FAQS: { question: string; answer: string }[] = [
  {
    question: "What do I need to get started?",
    answer:
      "A phone or laptop that can make a passkey: your face, fingerprint or device PIN. No wallet app, no seed phrase and no gas token.",
  },
  {
    question: "Does Weir hold my money?",
    answer:
      "No. Your dollars stay in your own account, or in savings only you can move, until a charge is due. Weir has no owner and no way to move anything you did not agree to.",
  },
  {
    question: "Can a business charge more than I agreed?",
    answer:
      "No. Every mandate carries three limits, per charge, per period and in total, and the contract refuses any charge over them or before it is due.",
  },
  {
    question: "How do I stop a payment?",
    answer:
      "One tap in Payments. A pause or a cancel takes effect on chain at once, and it needs nobody's permission.",
  },
  {
    question: "Is it live?",
    answer:
      "Yes. Weir is deployed on Monad Mainnet with real USDC and AUSD, and savings earn in Morpho's vaults until each charge. The same contracts run on Monad Testnet with test dollars, and the app switches between the two.",
  },
  {
    question: "Which dollars does it use?",
    answer:
      "USDC and AUSD on Monad. You can add money from other chains inside the app, and the payer never needs MON for fees.",
  },
];

const FOOTER_LINKS: { heading: string; items: { label: string; href: string; external?: boolean }[] }[] = [
  {
    heading: "Product",
    items: [
      { label: "How it works", href: "#start" },
      { label: "Why Weir", href: "#features" },
      { label: "Who it's for", href: "#who" },
    ],
  },
  {
    heading: "Weir",
    items: [
      { label: "Open the app", href: APP_URL, external: true },
      { label: "Videos", href: "/videos" },
      { label: "FAQ", href: "#faq" },
      { label: "Monad", href: "https://www.monad.xyz", external: true },
      { label: "Follow on X", href: X_URL, external: true },
    ],
  },
];

/**
 * The answer only exists while its question is open, so the reveal runs on mount
 * rather than on a class toggle. GSAP animates to `height: "auto"`, which CSS
 * transitions still cannot do without a hardcoded pixel height.
 */
function FaqAnswer({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const tween = gsap.fromTo(
      el,
      { height: 0, opacity: 0 },
      { height: "auto", opacity: 1, duration: 0.4, ease: "power2.out" },
    );
    return () => {
      tween.kill();
    };
  }, []);

  return (
    <div ref={ref} className="overflow-hidden">
      <p className="mt-3 text-[0.9rem] leading-[1.6] text-[#666]">{children}</p>
    </div>
  );
}

export function ClosingFooter({ logoSrc, faqId }: { logoSrc: string; faqId?: string }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(0);

  return (
    <div className="bg-white text-[#18161B]">
      <main className="mx-auto w-full max-w-[1100px] px-5 py-[60px] md:py-20">
        <div className="grid grid-cols-1 items-stretch gap-[60px] md:grid-cols-[1.6fr_1fr] md:gap-[30px]">
          <div
            className="weir-gradient flex flex-col items-center justify-center rounded-[24px] px-6 py-14 text-center text-white sm:px-10 sm:py-20"
            style={{ boxShadow: "0 10px 30px rgba(0, 0, 0, 0.05)" }}
          >
            <h2
              className="mb-[15px] font-normal leading-[1.1]"
              // Was a flat 3.5rem, which does not shrink. On a 320px phone the
              // fixed size left the words with almost no gutter.
              style={{ fontSize: "clamp(2.25rem, 11vw, 3.5rem)", letterSpacing: "-0.03em" }}
            >
              Say yes once.
              <br />
              Stop any time.
            </h2>
            <p className="mb-[30px] text-[0.95rem] font-normal opacity-85">
              Set up your first mandate in under a minute, with a passkey and nothing else
            </p>
            <a
              href={APP_URL}
              target="_blank"
              rel="noreferrer"
              className="cursor-pointer border-none bg-[#18161B] text-[0.95rem] font-semibold text-white transition-transform duration-200 hover:-translate-y-0.5"
              style={{
                padding: "14px 32px",
                borderRadius: "12px",
                boxShadow: "0 10px 20px rgba(0,0,0,0.3)",
              }}
            >
              Open Weir
            </a>
          </div>

          <div id={faqId} className="flex scroll-mt-24 flex-col justify-center gap-3">
            {FAQS.map((faq, index) => {
              const isActive = activeIndex === index;
              return (
                <button
                  type="button"
                  key={faq.question}
                  onClick={() => setActiveIndex(isActive ? null : index)}
                  className={`cursor-pointer rounded-[10px] border bg-white px-5 py-[18px] text-left transition-all duration-200 ${
                    isActive ? "border-[#eaeaea]" : "border-[#f0f0f0] hover:border-[#eaeaea]"
                  }`}
                  style={{
                    boxShadow: isActive
                      ? "0 4px 12px rgba(0,0,0,0.04)"
                      : "0 2px 8px rgba(0,0,0,0.02)",
                  }}
                  aria-expanded={isActive}
                >
                  <div className="flex items-center justify-between gap-3 text-[0.9rem] font-normal text-[#18161B]">
                    <span>{faq.question}</span>
                    {isActive ? (
                      <ChevronUp size={20} className="shrink-0" />
                    ) : (
                      <ChevronDown size={20} className="shrink-0" />
                    )}
                  </div>
                  {isActive && <FaqAnswer>{faq.answer}</FaqAnswer>}
                </button>
              );
            })}
          </div>
        </div>
      </main>

      <footer className="rounded-t-[32px] bg-[#fafafa] pb-5 pt-[60px] md:rounded-t-[56px] md:pt-20">
        <div className="mx-auto w-full max-w-[1100px] px-5">
          <div className="mb-[50px] grid grid-cols-1 gap-10 min-[480px]:grid-cols-2 md:grid-cols-[2fr_1fr_1fr_2fr]">
            <div>
              <img src={logoSrc} alt="Weir" width={24} height={24} className="mb-[15px] h-6 w-6" />
              <p className="max-w-[220px] text-[0.85rem] leading-[1.6] text-[#888]">
                Direct debit for digital dollars. Your money stays yours until it is due.
              </p>
            </div>

            {FOOTER_LINKS.map((column) => (
              <div key={column.heading}>
                <h4 className="mb-5 text-[0.95rem] font-semibold text-[#18161B]">
                  {column.heading}
                </h4>
                <ul>
                  {column.items.map((item) => (
                    <li key={item.label} className="mb-3">
                      <a
                        href={item.href}
                        {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}
                        className="text-[0.85rem] text-[#888] no-underline transition-colors duration-200 hover:text-[#18161B]"
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            <div>
              <h4 className="mb-5 text-[0.95rem] font-semibold text-[#18161B]">Try it now</h4>
              <p className="mb-[15px] text-[0.85rem] text-[#888]">
                Weir is live on Monad Mainnet. To try it for free, switch the app to Testnet, where dollars come in one tap.
              </p>
              <a
                href={APP_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-block cursor-pointer border-none bg-[#18161B] text-[0.9rem] font-semibold text-white transition-transform duration-200 hover:-translate-y-0.5"
                style={{
                  padding: "12px 28px",
                  borderRadius: "10px",
                  boxShadow: "0 12px 24px rgba(0,0,0,0.4)",
                }}
              >
                Open Weir
              </a>
            </div>
          </div>

          <div className="flex flex-col items-center gap-[15px] border-t border-[#f0f0f0] pb-[10px] pt-[25px] text-[0.85rem] text-[#888] min-[480px]:flex-row min-[480px]:justify-between">
            <span>Weir, 2026</span>
            <div className="flex items-center gap-4">
              <span>Live on Monad Mainnet</span>
              <a
                href={X_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="Weir on X"
                title="@weirstudio on X"
                className="-my-2 -mr-[9px] inline-flex h-8 w-8 items-center justify-center rounded-full text-[#888] transition-colors duration-200 hover:bg-[#f0f0f0] hover:text-[#18161B]"
              >
                <XLogo />
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
