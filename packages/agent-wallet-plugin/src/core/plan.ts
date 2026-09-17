/**
 * A plan's terms in plain words, from its checkout answer: what it costs and how often, when the
 * first charge lands, the caps a payer agrees to, how long it lasts, which dollars it takes and who
 * is paid. The same summary heads a subscribe, so an agent sees the terms before it signs them.
 */

import { networkFor, type CheckoutResponse, type MonadChainId } from "@weir/shared";
import type { Address } from "viem";

import { firstCharge } from "./terms.js";
import { apyPhrase, dateLong, durationPhrase, money, pricePhrase } from "./words.js";

const DAY = 86_400;

export interface PlanSummary {
  id: string;
  name: string;
  description: string;
  /** False when the business has paused the plan and takes no new subscribers. */
  active: boolean;
  merchant: { name: string; payoutAddress: Address; nadName?: string };
  network: { chainId: MonadChainId; label: string };
  asset: { address: Address; symbol: string };
  mode: "periodic" | "streaming";
  /** Base units per period, or per second for a stream. */
  amount: string;
  /** Seconds between charges; 0 for a stream. */
  period: number;
  trialDays: number;
  /** Base units the first charge takes right after install; "0" after a trial or for a stream. */
  firstCharge: string;
  maxPerCharge: string;
  maxTotal: string;
  termSeconds: number;
  /** Unix seconds the mandate would end if installed now. */
  endsAt: number;
  savings?: { vault: Address; name: string; symbol: string; apyBps?: number };
  /** The same terms as sentences, for a person. */
  words: {
    price: string;
    firstCharge: string;
    limits: string;
    term: string;
    /** The end date alone, "20 September 2027". */
    ends: string;
    asset: string;
    merchant: string;
    savings?: string;
  };
}

export function summarizePlan(checkout: CheckoutResponse, chainId: MonadChainId, now: number, timeZone?: string): PlanSummary {
  const { plan } = checkout;
  const endsAt = now + plan.termSeconds;
  const first = firstCharge(plan);
  const network = networkFor(chainId);
  const streaming = plan.mode === "streaming";

  const firstWords = streaming
    ? plan.trialDays > 0
      ? `Billing starts after a ${plan.trialDays}-day free trial, on ${dateLong(now + plan.trialDays * DAY, timeZone)}`
      : "Billing starts at install, by the second while it runs"
    : plan.trialDays > 0
      ? `Free for ${plan.trialDays} days; the first charge of ${money(plan.amount)} is on ${dateLong(now + plan.trialDays * DAY, timeZone)}`
      : `${money(plan.amount)} right after install`;

  const savings = checkout.savingsVault;
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    active: plan.active,
    merchant: {
      name: plan.merchant.name,
      payoutAddress: plan.merchant.payoutAddress,
      ...(plan.merchant.nadName === undefined ? {} : { nadName: plan.merchant.nadName }),
    },
    network: { chainId, label: network.label },
    asset: { address: plan.asset, symbol: plan.assetSymbol },
    mode: plan.mode,
    amount: plan.amount,
    period: plan.period,
    trialDays: plan.trialDays,
    firstCharge: first.toString(),
    maxPerCharge: plan.maxPerCharge,
    maxTotal: plan.maxTotal,
    termSeconds: plan.termSeconds,
    endsAt,
    ...(savings === undefined
      ? {}
      : {
          savings: {
            vault: savings.address,
            name: savings.name,
            symbol: savings.symbol,
            ...(savings.apyBps === undefined ? {} : { apyBps: savings.apyBps }),
          },
        }),
    words: {
      price: pricePhrase(plan),
      firstCharge: firstWords,
      limits: streaming
        ? `At most ${money(plan.maxPerCharge)} in one charge and ${money(plan.maxTotal)} in total`
        : `At most ${money(plan.maxTotal)} in total`,
      term: `${durationPhrase(plan.termSeconds)}, ending ${dateLong(endsAt, timeZone)} if subscribed now`,
      ends: dateLong(endsAt, timeZone),
      asset: `${plan.assetSymbol} on ${network.label} (${plan.asset})`,
      merchant: `${plan.merchant.name}${plan.merchant.nadName === undefined ? "" : ` (${plan.merchant.nadName})`}, paid at ${plan.merchant.payoutAddress}`,
      ...(savings === undefined
        ? {}
        : {
            savings: `Can pay from ${savings.name} (${savings.symbol})${savings.apyBps === undefined ? "" : `, earning ${apyPhrase(savings.apyBps)}`} until each charge`,
          }),
    },
  };
}
