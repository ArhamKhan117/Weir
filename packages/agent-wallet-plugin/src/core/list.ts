/**
 * A payer's mandates from the API's index: each one's standing, what it costs, when it next
 * charges and how much it has taken against its cap, with totals across them all.
 */

import { networkFor, type MandateView, type MonadChainId } from "@weir/shared";
import { zeroAddress, type Address } from "viem";

import type { Deps } from "./deps.js";
import { chainOf } from "./settings.js";
import { dateLong, fromNow, mandatePricePhrase, money, moneyExact } from "./words.js";

export interface MandateLine {
  id: string;
  title: string;
  merchant: Address;
  planId?: string;
  standing: MandateView["standing"];
  mode: "periodic" | "streaming";
  assetSymbol: string;
  paysFrom: "balance" | "savings";
  amount: string;
  period: number;
  /** Unix seconds of the next periodic charge; absent for streams and anything that cannot charge again. */
  nextChargeAt?: number;
  totalCharged: string;
  maxTotal: string;
  expiresAt: number;
  createdTx: string;
  words: { price: string; next: string; paid: string; ends: string };
}

export interface ListReport {
  payer: Address;
  network?: { chainId: MonadChainId; label: string };
  mandates: MandateLine[];
  totals: {
    mandates: number;
    /** Active or past due: still charging. */
    running: number;
    paused: number;
    /** Base units charged so far, per asset symbol. */
    paid: Record<string, string>;
    next?: { mandateId: string; title: string; at: number; amount: string; words: string };
  };
}

const LIVE = new Set<MandateView["standing"]>(["Active", "Past due", "Paused"]);

export function mandateLine(view: MandateView, now: number, timeZone?: string): MandateLine {
  const streaming = view.period === 0;
  const live = LIVE.has(view.standing);
  const chargesAgain = live && !streaming && view.standing !== "Paused";
  const title = view.plan === undefined ? `Mandate #${view.id}` : `${view.plan.name} from ${view.plan.merchantName}`;
  const paid = streaming ? moneyExact(view.totalCharged) : money(view.totalCharged);

  const next =
    view.standing === "Paused"
      ? "Paused, nothing is billed"
      : !live
        ? "No more charges"
        : streaming
          ? "Running now, billed by the second"
          : view.nextChargeAt <= now
            ? `Due now (${money(view.amount)})`
            : `Next charge ${dateLong(view.nextChargeAt, timeZone)}, ${fromNow(view.nextChargeAt, now)}`;

  return {
    id: view.id,
    title,
    merchant: view.merchant,
    ...(view.plan === undefined ? {} : { planId: view.plan.id }),
    standing: view.standing,
    mode: streaming ? "streaming" : "periodic",
    assetSymbol: view.assetSymbol,
    paysFrom: view.vault === zeroAddress ? "balance" : "savings",
    amount: view.amount,
    period: view.period,
    ...(chargesAgain ? { nextChargeAt: view.nextChargeAt } : {}),
    totalCharged: view.totalCharged,
    maxTotal: view.maxTotal,
    expiresAt: view.expiresAt,
    createdTx: view.createdTx,
    words: {
      price: mandatePricePhrase({ amount: view.amount, period: view.period }),
      next,
      paid: `Paid ${paid} of ${money(view.maxTotal)}`,
      ends: `${view.expiresAt < now ? "Ended" : "Ends"} ${dateLong(view.expiresAt, timeZone)}`,
    },
  };
}

export function summarize(payer: Address, views: MandateView[], now: number, chainId?: MonadChainId, timeZone?: string): ListReport {
  const lines = views.map((view) => mandateLine(view, now, timeZone));
  const paid: Record<string, bigint> = {};
  for (const view of views) paid[view.assetSymbol] = (paid[view.assetSymbol] ?? 0n) + BigInt(view.totalCharged);

  const upcoming = lines
    .filter((line): line is MandateLine & { nextChargeAt: number } => line.nextChargeAt !== undefined)
    .sort((a, b) => a.nextChargeAt - b.nextChargeAt)[0];

  return {
    payer,
    ...(chainId === undefined ? {} : { network: { chainId, label: networkFor(chainId).label } }),
    mandates: lines,
    totals: {
      mandates: lines.length,
      running: lines.filter((line) => line.standing === "Active" || line.standing === "Past due").length,
      paused: lines.filter((line) => line.standing === "Paused").length,
      paid: Object.fromEntries(Object.entries(paid).map(([symbol, units]) => [symbol, units.toString()])),
      ...(upcoming === undefined
        ? {}
        : {
            next: {
              mandateId: upcoming.id,
              title: upcoming.title,
              at: upcoming.nextChargeAt,
              amount: upcoming.amount,
              words: `${money(upcoming.amount)} for ${upcoming.title}, ${upcoming.nextChargeAt <= now ? "due now" : `on ${dateLong(upcoming.nextChargeAt, timeZone)}`}`,
            },
          }),
    },
  };
}

/** The payer's mandates, newest first as the API returns them. */
export async function listMandates(deps: Deps, payer: Address): Promise<ListReport> {
  const [answer, health] = await Promise.all([deps.api.payer(payer), deps.api.health().catch(() => undefined)]);
  const chainId = health === undefined ? undefined : chainOf(health.chainId, deps.settings);
  return summarize(payer, answer.mandates, deps.now(), chainId, deps.timeZone);
}
