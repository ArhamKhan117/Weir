/**
 * The merchant overview's figures, from the indexed mandates and charges.
 *
 * MRR is the sum over mandates whose standing is `Active` and that charge by the period, each
 * contributing `amount * 30 days / period`, rounded down per mandate. A stream has no recurring
 * amount to scale, so it is left out rather than guessed at. `collected30d` is what `Charged`
 * moved in the last thirty days. Both are keyed by asset symbol and summed exactly in `bigint`.
 */

import type { MandateView, MerchantOverview, Units } from "@weir/shared";

export const THIRTY_DAYS = 2_592_000;

/** One mandate's contribution to MRR, in base units. Zero for anything not active and periodic. */
export function monthlyAmount(mandate: Pick<MandateView, "standing" | "period" | "amount">): bigint {
  if (mandate.standing !== "Active" || mandate.period === 0) return 0n;
  return (BigInt(mandate.amount) * BigInt(THIRTY_DAYS)) / BigInt(mandate.period);
}

function add(totals: Map<string, bigint>, key: string, amount: bigint): void {
  totals.set(key, (totals.get(key) ?? 0n) + amount);
}

function toUnits(totals: Map<string, bigint>): Record<string, Units> {
  return Object.fromEntries([...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value.toString()]));
}

export function merchantStats(
  mandates: readonly Pick<MandateView, "standing" | "period" | "amount" | "assetSymbol">[],
  collected: readonly { assetSymbol: string; amount: Units }[],
): MerchantOverview["stats"] {
  let activeMandates = 0;
  let pastDue = 0;
  const mrr = new Map<string, bigint>();
  for (const mandate of mandates) {
    if (mandate.standing === "Active") activeMandates += 1;
    if (mandate.standing === "Past due") pastDue += 1;
    const monthly = monthlyAmount(mandate);
    if (monthly > 0n) add(mrr, mandate.assetSymbol, monthly);
  }
  const collected30d = new Map<string, bigint>();
  for (const entry of collected) add(collected30d, entry.assetSymbol, BigInt(entry.amount));
  return { activeMandates, pastDue, mrr: toUnits(mrr), collected30d: toUnits(collected30d) };
}
