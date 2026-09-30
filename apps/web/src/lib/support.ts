/**
 * Family support: the terms a contribution installs, and the two messages around it.
 *
 * A contribution is a mandate like any other, paying the circle's recipient directly: the amount
 * the supporter chose, every period the circle asks for, capped at that amount per charge and at a
 * year of charges in total, and expiring after a year. Its `ref` is the circle's id, which is how
 * the recipient's page finds it.
 */

import {
  randomNonce,
  refFromString,
  SUPPORT_PERIODS,
  supportCircleTypedData,
  supporterNameTypedData,
  type MandateTerms,
  type SupportCircle,
} from "@weir/shared";
import { zeroAddress, type Address, type LocalAccount } from "viem";

import { api } from "./api";
import { CHAIN_ID } from "./config";
import { SIGNATURE_WINDOW } from "./mandate";

const YEAR = 365 * 86_400;

/** How many contributions a year of `period` makes: 52 weekly, 12 monthly. */
export function perYear(period: number): number {
  return period === SUPPORT_PERIODS.week ? 52 : 12;
}

/** "week" or "month", for copy. */
export function periodWord(period: number): "week" | "month" {
  return period === SUPPORT_PERIODS.week ? "week" : "month";
}

export function termsForSupport(
  circle: SupportCircle,
  amount: bigint,
  options: { manager: Address; vault?: Address; now?: number },
): MandateTerms {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return {
    merchant: circle.recipient,
    asset: circle.asset,
    vault: options.vault ?? zeroAddress,
    manager: options.manager,
    amount,
    period: circle.period,
    startAt: 0n,
    maxPerCharge: amount,
    maxTotal: amount * BigInt(perYear(circle.period)),
    expiresAt: BigInt(now + YEAR),
    ref: refFromString(circle.id),
  };
}

/** How long a one-off contribution stays open to be charged; the relayer charges it at once. */
const ONCE_WINDOW = 7 * 86_400;

/**
 * A single contribution ("send now"): one charge of `amount`, due the moment it exists, which the
 * relayer charges in the same transaction that sets it up.
 */
export function termsForOnce(
  circle: SupportCircle,
  amount: bigint,
  options: { manager: Address; vault?: Address; now?: number },
): MandateTerms {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return { ...termsForSupport(circle, amount, options), maxTotal: amount, expiresAt: BigInt(now + ONCE_WINDOW) };
}

/** Opens a circle for the owner, who is its recipient: only they can open one that pays them. */
export async function openSupport(
  owner: LocalAccount,
  input: { name: string; note: string; currency: string; asset: Address; period: number; goal: bigint },
): Promise<SupportCircle> {
  const nonce = randomNonce();
  const deadline = Math.floor(Date.now() / 1000) + SIGNATURE_WINDOW;
  const circle = {
    recipient: owner.address,
    name: input.name.trim(),
    note: input.note.trim(),
    currency: input.currency,
    asset: input.asset,
    period: input.period,
    goal: input.goal,
  };
  const signature = await owner.signTypedData(supportCircleTypedData({ chainId: CHAIN_ID, ...circle, nonce, deadline: BigInt(deadline) }));
  return api.openSupport({ ...circle, goal: circle.goal.toString(), nonce: nonce.toString(), deadline, signature });
}

/** Names the supporter behind `mandateId` for the recipient, signed by the session key that manages it. */
export async function nameSupporter(session: LocalAccount, hub: Address, circleId: string, mandateId: string, name: string): Promise<void> {
  const deadline = Math.floor(Date.now() / 1000) + SIGNATURE_WINDOW;
  const text = name.trim();
  const signature = await session.signTypedData(
    supporterNameTypedData({ chainId: CHAIN_ID, hub, mandateId: BigInt(mandateId), name: text, deadline: BigInt(deadline) }),
  );
  await api.nameSupporter(circleId, mandateId, { name: text, signer: session.address, deadline, signature });
}
