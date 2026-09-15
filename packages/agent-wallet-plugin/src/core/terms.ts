/**
 * A plan's mandate terms, exactly as the web checkout builds them, so a mandate an agent installs
 * is indistinguishable on chain from one a person installs in the browser.
 */

import { refFromString, type MandateTerms, type Plan, type WireTerms } from "@weir/shared";
import { zeroAddress, type Address } from "viem";

const DAY = 86_400;

/** How long a signature stays valid: long enough for a slow approval, short enough to be useless later. */
export const SIGNATURE_WINDOW = 15 * 60;

/** The terms a checkout installs for `plan`, paying the merchant, with `manager` able to pause, resume and stop. */
export function termsFor(plan: Plan, options: { manager: Address; vault?: Address; now: number }): MandateTerms {
  const { now } = options;
  return {
    merchant: plan.merchant.payoutAddress,
    asset: plan.asset,
    vault: options.vault ?? zeroAddress,
    manager: options.manager,
    amount: BigInt(plan.amount),
    period: plan.mode === "streaming" ? 0 : plan.period,
    startAt: plan.trialDays > 0 ? BigInt(now + plan.trialDays * DAY) : 0n,
    maxPerCharge: BigInt(plan.maxPerCharge),
    maxTotal: BigInt(plan.maxTotal),
    expiresAt: BigInt(now + plan.termSeconds),
    ref: refFromString(plan.id),
  };
}

/** The terms with amounts as decimal strings, as `POST /v1/relay/install` takes them. */
export function toWire(terms: MandateTerms): WireTerms {
  return {
    merchant: terms.merchant,
    asset: terms.asset,
    vault: terms.vault,
    manager: terms.manager,
    amount: terms.amount.toString(),
    period: terms.period,
    startAt: Number(terms.startAt),
    maxPerCharge: terms.maxPerCharge.toString(),
    maxTotal: terms.maxTotal.toString(),
    expiresAt: Number(terms.expiresAt),
    ref: terms.ref,
  };
}

/** What the first charge takes: a periodic plan with no trial is charged its amount right after install. */
export function firstCharge(plan: Pick<Plan, "mode" | "trialDays" | "amount">): bigint {
  return plan.mode === "periodic" && plan.trialDays === 0 ? BigInt(plan.amount) : 0n;
}
