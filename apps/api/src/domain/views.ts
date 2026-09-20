/**
 * Database rows to the wire types in `@weir/shared/api`.
 *
 * Amounts leave as decimal strings exactly as Postgres returns `numeric`, times as numbers, and
 * `standing` is derived here at read time with `standingOf`, because expiry and completion are
 * never written on chain and so never stored.
 */

import {
  standingOf,
  type ChargeView,
  type MandateStatus,
  type MandateView,
  type MerchantProfile,
  type MerchantPublic,
  type Plan,
  type PlanMode,
  type SupportCircle,
} from "@weir/shared";
import { zeroAddress, type Address, type Hex } from "viem";

export interface MandateRow {
  id: string;
  payer: Address;
  merchant: Address;
  asset: Address;
  vault: Address;
  manager: Address;
  amount: string;
  period: number;
  next_charge_at: string;
  max_per_charge: string;
  max_total: string;
  total_charged: string;
  expires_at: string;
  paused_at: string;
  status: MandateStatus;
  ref: Hex;
  created_at: string;
  created_tx: Hex;
  plan_id: string | null;
  plan_name: string | null;
  plan_description: string | null;
  plan_mode: PlanMode | null;
  plan_merchant_name: string | null;
  support_id: string | null;
  support_name: string | null;
  supporter_name: string | null;
}

export interface SupportRow {
  id: string;
  recipient: Address;
  name: string;
  note: string;
  currency: string;
  asset: Address;
  period: number;
  goal: string;
  created_at: string;
}

export interface ChargeRow {
  mandate_id: string;
  kind: "charged" | "failed";
  amount: string;
  reason: number | null;
  block_time: string;
  block_number: string;
  tx_hash: Hex;
  payer: Address;
  merchant: Address;
  asset: Address;
}

export interface MerchantRow {
  id: string;
  auth_subject: string;
  name: string;
  payout_address: Address | null;
  webhook_url: string | null;
  webhook_since: string | null;
  created_at: string;
}

export interface PlanRow {
  id: string;
  name: string;
  description: string;
  asset: Address;
  mode: PlanMode;
  amount: string;
  period: number;
  trial_days: number;
  max_per_charge: string;
  max_total: string;
  term_seconds: string;
  active: boolean;
  created_at: string;
  merchant_id: string;
  merchant_name: string;
  merchant_payout: Address | null;
}

export function toMandateView(row: MandateRow, assetSymbol: string, nowSeconds: number): MandateView {
  const record = {
    status: row.status,
    pausedAt: BigInt(row.paused_at),
    expiresAt: BigInt(row.expires_at),
    totalCharged: BigInt(row.total_charged),
    maxTotal: BigInt(row.max_total),
    amount: BigInt(row.amount),
    period: row.period,
  };
  const view: MandateView = {
    id: row.id,
    payer: row.payer,
    merchant: row.merchant,
    asset: row.asset,
    assetSymbol,
    vault: row.vault,
    manager: row.manager,
    amount: row.amount,
    period: row.period,
    nextChargeAt: Number(row.next_charge_at),
    maxPerCharge: row.max_per_charge,
    maxTotal: row.max_total,
    totalCharged: row.total_charged,
    expiresAt: Number(row.expires_at),
    pausedAt: Number(row.paused_at),
    status: row.status,
    standing: standingOf(record, BigInt(nowSeconds)),
    ref: row.ref,
    createdAt: Number(row.created_at),
    createdTx: row.created_tx,
  };
  if (row.plan_id !== null && row.plan_name !== null && row.plan_mode !== null) {
    view.plan = {
      id: row.plan_id,
      name: row.plan_name,
      description: row.plan_description ?? "",
      mode: row.plan_mode,
      merchantName: row.plan_merchant_name ?? "",
    };
  }
  if (row.support_id !== null && row.support_name !== null) {
    view.support = { id: row.support_id, name: row.support_name };
  }
  return view;
}

export function toSupportCircle(row: SupportRow, assetSymbol: string): SupportCircle {
  return {
    id: row.id,
    recipient: row.recipient,
    name: row.name,
    note: row.note,
    currency: row.currency,
    asset: row.asset,
    assetSymbol,
    period: row.period,
    goal: row.goal,
    createdAt: Number(row.created_at),
  };
}

export function toChargeView(row: ChargeRow): ChargeView {
  return {
    mandateId: row.mandate_id,
    kind: row.kind,
    amount: row.amount,
    ...(row.reason === null ? {} : { reason: Number(row.reason) }),
    merchant: row.merchant,
    payer: row.payer,
    asset: row.asset,
    timestamp: Number(row.block_time),
    blockNumber: Number(row.block_number),
    transaction: row.tx_hash,
  };
}

export function toMerchantPublic(row: Pick<MerchantRow, "id" | "name" | "payout_address">): MerchantPublic {
  // An unset payout address reads as the zero address, the codebase's marker for "none".
  return { id: row.id, name: row.name, payoutAddress: row.payout_address ?? zeroAddress };
}

export function toMerchantProfile(row: MerchantRow): MerchantProfile {
  return {
    ...toMerchantPublic(row),
    createdAt: Number(row.created_at),
    ...(row.webhook_url === null ? {} : { webhookUrl: row.webhook_url }),
  };
}

export function toPlan(row: PlanRow, assetSymbol: string): Plan {
  return {
    id: row.id,
    merchant: toMerchantPublic({ id: row.merchant_id, name: row.merchant_name, payout_address: row.merchant_payout }),
    name: row.name,
    description: row.description,
    asset: row.asset,
    assetSymbol,
    mode: row.mode,
    amount: row.amount,
    period: row.period,
    trialDays: row.trial_days,
    maxPerCharge: row.max_per_charge,
    maxTotal: row.max_total,
    termSeconds: Number(row.term_seconds),
    active: row.active,
    createdAt: Number(row.created_at),
  };
}
