/**
 * Off-chain type model shared by the web app, the API, the keeper and the indexer.
 *
 * Every on-chain integer arrives as a `bigint`, because that is what viem decodes `uint64` and
 * wider into, and converting at the boundary is how precision gets lost. The exceptions are
 * `period`, a `uint32` the UI edits as a number, and the enum-like fields.
 */

import type { Address, Hex } from "viem";

export type { Address, Hex };

/** `period` value that marks a streaming mandate. */
export const STREAMING_PERIOD = 0;

/**
 * The terms a payer agrees to, field for field as `IMandateHub.Terms`.
 *
 * `amount` is base units per period, or per second when `period` is `STREAMING_PERIOD`.
 */
export interface MandateTerms {
  merchant: Address;
  asset: Address;
  /**
   * The zero address to draw from the payer's balance of `asset`, or an ERC-4626 vault over
   * `asset` to draw from the payer's shares in it, so savings earn until each charge.
   */
  vault: Address;
  /** A session key that may pause, resume and cancel, or the zero address for none. */
  manager: Address;
  amount: bigint;
  period: number;
  /** Unix seconds, or `0n` for the creation block. */
  startAt: bigint;
  maxPerCharge: bigint;
  maxTotal: bigint;
  /** Unix seconds, inclusive. */
  expiresAt: bigint;
  /** 32 bytes of merchant reference, typically a plan id. */
  ref: Hex;
}

/** On-chain lifecycle status, in `IMandateHub.Status` order. */
export type MandateStatus = "Active" | "Delinquent" | "Cancelled";

export const MANDATE_STATUSES = ["Active", "Delinquent", "Cancelled"] as const satisfies readonly MandateStatus[];

/** The status for the enum index viem decodes, refusing anything the contract cannot return. */
export function mandateStatusFromIndex(index: number): MandateStatus {
  const status = MANDATE_STATUSES[index];
  if (status === undefined) throw new RangeError(`No mandate status has index ${index}`);
  return status;
}

/** A mandate as `getMandate` returns it, with its id. */
export interface MandateRecord {
  id: bigint;
  payer: Address;
  merchant: Address;
  asset: Address;
  vault: Address;
  manager: Address;
  amount: bigint;
  period: number;
  /** Next boundary for a periodic mandate; accrual checkpoint for a stream. */
  nextChargeAt: bigint;
  maxPerCharge: bigint;
  maxTotal: bigint;
  totalCharged: bigint;
  expiresAt: bigint;
  /** Zero while running; the pause moment for a paused stream. */
  pausedAt: bigint;
  status: MandateStatus;
}

export function isStreaming(mandate: Pick<MandateTerms, "period">): boolean {
  return mandate.period === STREAMING_PERIOD;
}

/**
 * The state a person reads, derived rather than stored: the contract never transitions a
 * mandate at expiry or at its cap, so "Expired" and "Completed" exist only here.
 */
export type MandateStanding = "Active" | "Paused" | "Past due" | "Cancelled" | "Expired" | "Completed";

export function standingOf(
  mandate: Pick<MandateRecord, "status" | "pausedAt" | "expiresAt" | "totalCharged" | "maxTotal" | "amount" | "period">,
  nowSeconds: bigint,
): MandateStanding {
  if (mandate.status === "Cancelled") return "Cancelled";
  if (nowSeconds > mandate.expiresAt) return "Expired";
  const spent = isStreaming(mandate)
    ? mandate.totalCharged >= mandate.maxTotal
    : mandate.totalCharged + mandate.amount > mandate.maxTotal;
  if (spent) return "Completed";
  if (mandate.pausedAt !== 0n) return "Paused";
  if (mandate.status === "Delinquent") return "Past due";
  return "Active";
}
