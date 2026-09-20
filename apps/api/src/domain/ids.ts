/**
 * Identifiers the API mints: plans, merchants and support circles.
 *
 * A plan id is `pln_` and 16 lowercase base32 characters, 80 random bits in 20 ASCII bytes, so it
 * fits the mandate's 32-byte `ref` with room to spare and `refFromString(plan.id)` ties every
 * charge on chain back to its plan.
 */

import { randomBytes } from "node:crypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** `length` characters of lowercase RFC 4648 base32. 32 divides 256, so `byte & 31` is uniform. */
export function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += BASE32[byte & 31];
  return out;
}

export const PLAN_ID_PATTERN = /^pln_[a-z2-7]{16}$/;
export const MERCHANT_ID_PATTERN = /^mer_[a-z2-7]{16}$/;
/** A support circle's id, which its contributions carry in `ref` as a plan's do. */
export const SUPPORT_ID_PATTERN = /^sup_[a-z2-7]{16}$/;

export const newPlanId = (): string => `pln_${randomBase32(16)}`;
export const newMerchantId = (): string => `mer_${randomBase32(16)}`;
export const newSupportId = (): string => `sup_${randomBase32(16)}`;
