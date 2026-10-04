import {
  deploymentFor,
  MONAD_MAINNET_CHAIN_ID,
  MONAD_TESTNET_CHAIN_ID,
  monadMainnet,
  monadTestnet,
} from "@weir/shared";
import { useEffect, useState } from "react";
import { useInViewAnimation } from "../hooks/useInViewAnimation";
import { GLOBE_VIDEO } from "../media";
import { CurvedDivider } from "./CurvedDivider";
import { LazyVideo } from "./LazyVideo";

/** `nextMandateId()` on MandateHub. Ids start at 1, so the count is one less. */
const NEXT_MANDATE_ID_SELECTOR = "0x17cd54f2";

/** Both networks Weir runs on, Mainnet first: the counter shows one at a time. */
const NETWORKS = [
  { chainId: MONAD_MAINNET_CHAIN_ID, label: "Mainnet", name: "Monad Mainnet", chain: monadMainnet },
  { chainId: MONAD_TESTNET_CHAIN_ID, label: "Testnet", name: "Monad Testnet", chain: monadTestnet },
].filter((network) => deploymentFor(network.chainId) !== undefined);

type ChainId = (typeof NETWORKS)[number]["chainId"];

const STATS: { value: number; suffix: string; description: string }[] = [
  { value: 0, suffix: "%", description: "Taken from a charge by Weir. There is no fee, and no owner who could add one" },
  { value: 800, suffix: "ms", description: "Until a charge is final on Monad, settled before you look away" },
  { value: 100, suffix: "%", description: "Of your money stays in your own account until a charge is due" },
];

/**
 * How many mandates a network's hub has ever created, read straight from the contract with one
 * `eth_call`. A raw JSON-RPC request rather than a chain client, so the page carries no library for
 * one number. The figure is whatever the chain says, small or not; a failed read shows no number.
 */
async function readMandateCount(network: (typeof NETWORKS)[number]): Promise<number | undefined> {
  const deployment = deploymentFor(network.chainId);
  const rpc = network.chain.rpcUrls.default.http[0];
  if (deployment === undefined || rpc === undefined) return undefined;
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: deployment.contracts.MandateHub, data: NEXT_MANDATE_ID_SELECTOR }, "latest"],
    }),
  });
  const body = (await response.json()) as { result?: unknown };
  if (typeof body.result !== "string" || !/^0x[0-9a-f]+$/i.test(body.result)) return undefined;
  return Math.max(0, Number(BigInt(body.result)) - 1);
}

/** Ease-out cubic. Fast at the start, so the number feels like it lands. */
function useCountUp(target: number, active: boolean, duration = 1000) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      setValue(Math.round(target * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, active, duration]);

  return value;
}

function Stat({ value, suffix, description }: (typeof STATS)[number] & { active: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-[40px] font-light leading-[0.9] tracking-[-0.03em] text-[#18161B] md:text-[68px]">
        {value}
        <span className="text-[#18161B]/40">{suffix}</span>
      </span>
      <p className="text-base leading-snug text-[#18161B]/50 md:text-lg">{description}</p>
    </div>
  );
}

function AnimatedStat({ entry, active }: { entry: (typeof STATS)[number]; active: boolean }) {
  const value = useCountUp(entry.value, active);
  return <Stat {...entry} value={value} active={active} />;
}

export function CounterSection() {
  const { ref, isInView } = useInViewAnimation<HTMLElement>();
  const [chainId, setChainId] = useState<ChainId | undefined>(NETWORKS[0]?.chainId);
  // Per network: undefined while reading, null when the read failed.
  const [counts, setCounts] = useState<Partial<Record<ChainId, number | null>>>({});
  const network = NETWORKS.find((n) => n.chainId === chainId);
  const count = chainId === undefined ? null : counts[chainId];
  const headline = useCountUp(count ?? 0, isInView && count != null, 1400);

  useEffect(() => {
    let cancelled = false;
    for (const n of NETWORKS) {
      readMandateCount(n)
        .catch(() => undefined)
        .then((result) => {
          if (!cancelled) setCounts((previous) => ({ ...previous, [n.chainId]: result ?? null }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section ref={ref} className="overflow-hidden pt-[130px] md:pt-[200px]">
      <div className="mx-auto flex max-w-[1260px] flex-col items-center gap-[60px] px-6 text-center">
        <div className="flex max-w-[540px] flex-col items-center gap-5">
          <span className="rounded-full border border-[#18161B]/10 bg-white px-4 py-2 text-[13px] text-[#18161B]/60">
            Live on Monad Mainnet, read from the chain
          </span>

          <h2
            className="font-light text-[#18161B]"
            style={{
              fontSize: "clamp(2.1rem, 6vw, 4.25rem)",
              lineHeight: 0.98,
              letterSpacing: "-0.03em",
            }}
          >
            Every mandate is public, and anyone can check it
          </h2>

          {NETWORKS.length > 1 && (
            <div role="group" aria-label="Network" className="mt-2 inline-flex rounded-full border border-[#18161B]/10 bg-white p-1">
              {NETWORKS.map((n) => (
                <button
                  key={n.chainId}
                  type="button"
                  aria-pressed={n.chainId === chainId}
                  onClick={() => setChainId(n.chainId)}
                  className={`cursor-pointer rounded-full px-4 py-1.5 text-[13px] transition-colors duration-200 ${
                    n.chainId === chainId ? "bg-[#18161B] text-white" : "text-[#18161B]/60 hover:text-[#18161B]"
                  }`}
                >
                  {n.label}
                </button>
              ))}
            </div>
          )}

          {/* Laid out before the read lands, so the section does not jump when it does. */}
          {count !== null && (
            <>
              <span
                className={`text-[60px] font-light leading-none tracking-[-0.03em] text-[#18161B] transition-opacity duration-500 md:text-[100px] lg:text-[120px] ${
                  count === undefined ? "opacity-0" : "opacity-100"
                }`}
              >
                {headline.toLocaleString("en-US")}
              </span>

              <p className="text-base text-[#18161B]/50 md:text-lg">
                Mandates set up on {network?.name ?? "Monad"} so far, counted from the contract as
                this page loaded
              </p>
            </>
          )}
        </div>

        <div className="relative w-full max-w-[1080px]">
          <div className="h-[280px] overflow-hidden md:h-[440px]">
            <LazyVideo
              sources={GLOBE_VIDEO}
              poster="/media/globe-poster.jpg"
              className="h-[500px] w-full object-cover md:h-[800px]"
              style={{ mixBlendMode: "darken" }}
            />
          </div>
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-32"
            style={{ background: "linear-gradient(to bottom, transparent, #F4F0ED)" }}
          />
        </div>

        <div className="grid w-full max-w-[840px] grid-cols-1 gap-8 text-left sm:grid-cols-3 md:gap-[50px]">
          {STATS.map((entry) => (
            <AnimatedStat key={entry.description} entry={entry} active={isInView} />
          ))}
        </div>
      </div>

      {/* Room under the figures so they are not pinned to the seam, then the
          curve into the white section below. */}
      <div className="h-[100px] md:h-[160px]" />
      <CurvedDivider fill="#ffffff" />
    </section>
  );
}
