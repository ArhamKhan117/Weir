/**
 * Metered mandates in Postgres: the indexed meters, what the facilitator accepted, and the views.
 *
 * Two kinds of state live side by side. `meters` and `meter_settlements` are the chain's, written
 * only by the indexer from `MandateMeter`'s events and `getMeter`. `meter_usage` and `meter_calls`
 * are the facilitator's own: the latest usage receipt it accepted for each meter, and one row per
 * paid request. Accepting is a compare-and-swap on the last total, so two requests racing on one
 * meter can never both be accepted on the same base.
 */

import type { MeterCall, MeterDetail, MeterSettlement, MeterStatus, MeterView } from "@weir/shared";
import type { Address, Hex } from "viem";

import type { Db, Sql } from "./database.js";

export interface MeterScope {
  chainId: number;
  /** The `MandateMeter` contract. */
  meter: Address;
}

interface MeterRow {
  id: string;
  payer: Address;
  merchant: Address;
  asset: Address;
  manager: Address;
  period_cap: string;
  period: number;
  max_total: string;
  expires_at: string;
  ref: Hex;
  status: MeterStatus;
  total_charged: string;
  closed_at: string;
  created_at: string;
  created_tx: Hex;
  usage_total: string | null;
  usage_period_start: string | null;
  usage_period_used: string | null;
  usage_calls: string | null;
  last_call_at: string | null;
}

/** The start of the period `nowSeconds` falls in: periods run from the meter's creation, as on chain. */
export function periodStartAt(createdAt: number, period: number, nowSeconds: number): number {
  if (nowSeconds < createdAt) return createdAt;
  return nowSeconds - ((nowSeconds - createdAt) % period);
}

const SELECT = (db: Db) => db`
  SELECT m.id, m.payer, m.merchant, m.asset, m.manager, m.period_cap, m.period, m.max_total, m.expires_at, m.ref,
         m.status, m.total_charged, m.closed_at, m.created_at, m.created_tx,
         u.total AS usage_total, u.period_start AS usage_period_start, u.period_used AS usage_period_used,
         u.calls AS usage_calls,
         (SELECT max(c.at) FROM meter_calls c WHERE c.chain_id = m.chain_id AND c.meter = m.meter AND c.meter_id = m.id) AS last_call_at
  FROM meters m
  LEFT JOIN meter_usage u ON u.chain_id = m.chain_id AND u.meter = m.meter AND u.meter_id = m.id`;

export class MeterStore {
  constructor(
    readonly sql: Sql,
    readonly scope: MeterScope,
    private readonly symbolFor: (asset: Address) => string,
  ) {}

  private view(row: MeterRow, nowSeconds: number): MeterView {
    const createdAt = Number(row.created_at);
    const periodStart = periodStartAt(createdAt, row.period, nowSeconds);
    const totalCharged = BigInt(row.total_charged);
    const accepted = row.usage_total === null ? totalCharged : BigInt(row.usage_total) > totalCharged ? BigInt(row.usage_total) : totalCharged;
    const periodUsed = row.usage_period_start !== null && Number(row.usage_period_start) === periodStart ? (row.usage_period_used ?? "0") : "0";
    return {
      id: row.id,
      meter: this.scope.meter,
      chainId: this.scope.chainId,
      payer: row.payer,
      merchant: row.merchant,
      asset: row.asset,
      assetSymbol: this.symbolFor(row.asset),
      manager: row.manager,
      periodCap: row.period_cap,
      period: row.period,
      maxTotal: row.max_total,
      expiresAt: Number(row.expires_at),
      ref: row.ref,
      status: row.status,
      closedAt: Number(row.closed_at),
      totalCharged: row.total_charged,
      accepted: accepted.toString(),
      periodUsed,
      periodStart,
      calls: Number(row.usage_calls ?? 0),
      ...(row.last_call_at === null ? {} : { lastCallAt: Number(row.last_call_at) }),
      createdAt,
      createdTransaction: row.created_tx,
    };
  }

  /** @param db a transaction to read inside, so a meter written in it is seen. */
  async meter(id: bigint, nowSeconds: number, db: Db = this.sql): Promise<MeterView | undefined> {
    const rows = await db<MeterRow[]>`
      ${SELECT(db)} WHERE m.chain_id = ${this.scope.chainId} AND m.meter = ${this.scope.meter} AND m.id = ${id.toString()}`;
    return rows[0] === undefined ? undefined : this.view(rows[0], nowSeconds);
  }

  async detail(id: bigint, nowSeconds: number): Promise<MeterDetail | undefined> {
    const meter = await this.meter(id, nowSeconds);
    if (meter === undefined) return undefined;
    const [calls, settlements] = await Promise.all([this.recentCalls(id, 20), this.settlements(id, 20)]);
    return { ...meter, recentCalls: calls, settlements };
  }

  /** Newest first. */
  async forPayer(payer: Address, nowSeconds: number): Promise<MeterView[]> {
    const rows = await this.sql<MeterRow[]>`
      ${SELECT(this.sql)} WHERE m.chain_id = ${this.scope.chainId} AND m.meter = ${this.scope.meter} AND m.payer = ${payer}
      ORDER BY m.created_at DESC, m.id DESC LIMIT 100`;
    return rows.map((row) => this.view(row, nowSeconds));
  }

  /** Meters a key may sign receipts for (as payer or manager) that pay `payTo` in `asset`, open first. */
  async forSigner(signer: Address, payTo: Address, asset: Address, nowSeconds: number): Promise<MeterView[]> {
    const rows = await this.sql<MeterRow[]>`
      ${SELECT(this.sql)} WHERE m.chain_id = ${this.scope.chainId} AND m.meter = ${this.scope.meter}
        AND (m.payer = ${signer} OR m.manager = ${signer}) AND m.merchant = ${payTo} AND m.asset = ${asset}
        AND m.status <> 'Cancelled' AND m.expires_at > ${nowSeconds}
      ORDER BY m.created_at DESC, m.id DESC LIMIT 20`;
    return rows.map((row) => this.view(row, nowSeconds));
  }

  /** Meters paying any wallet the business has proven it holds, newest first. */
  async forMerchant(merchantId: string, nowSeconds: number): Promise<MeterView[]> {
    const rows = await this.sql<MeterRow[]>`
      ${SELECT(this.sql)} WHERE m.chain_id = ${this.scope.chainId} AND m.meter = ${this.scope.meter}
        AND m.merchant IN (SELECT address FROM merchant_payouts WHERE merchant_id = ${merchantId})
      ORDER BY m.created_at DESC, m.id DESC LIMIT 200`;
    return rows.map((row) => this.view(row, nowSeconds));
  }

  async recentCalls(id: bigint, limit: number): Promise<MeterCall[]> {
    const rows = await this.sql<{ at: string; amount: string; total: string; resource: string | null }[]>`
      SELECT at, amount, total, resource FROM meter_calls
      WHERE chain_id = ${this.scope.chainId} AND meter = ${this.scope.meter} AND meter_id = ${id.toString()}
      ORDER BY total DESC LIMIT ${limit}`;
    return rows.map((row) => ({
      at: Number(row.at),
      amount: row.amount,
      total: row.total,
      ...(row.resource === null ? {} : { resource: row.resource }),
    }));
  }

  async settlements(id: bigint, limit: number): Promise<MeterSettlement[]> {
    const rows = await this.sql<
      { kind: "settled" | "failed"; amount: string; receipt_total: string | null; reason: number | null; block_time: string; tx_hash: Hex }[]
    >`
      SELECT kind, amount, receipt_total, reason, block_time, tx_hash FROM meter_settlements
      WHERE chain_id = ${this.scope.chainId} AND meter = ${this.scope.meter} AND meter_id = ${id.toString()}
      ORDER BY block_number DESC, log_index DESC LIMIT ${limit}`;
    return rows.map((row) => ({
      kind: row.kind,
      amount: row.amount,
      ...(row.receipt_total === null ? {} : { receiptTotal: row.receipt_total }),
      ...(row.reason === null ? {} : { reason: row.reason }),
      timestamp: Number(row.block_time),
      transaction: row.tx_hash,
    }));
  }

  /**
   * Records one paid request: the receipt for `total`, accepted only if the last accepted total is
   * still `previous`. Returns false when another request got there first.
   */
  async accept(input: {
    meterId: bigint;
    previous: bigint;
    total: bigint;
    amount: bigint;
    issuedAt: bigint;
    signature: Hex;
    periodStart: number;
    periodUsed: bigint;
    resource?: string;
    nowSeconds: number;
  }): Promise<boolean> {
    const { chainId, meter } = this.scope;
    const id = input.meterId.toString();
    return this.sql.begin(async (tx) => {
      const updated = await tx`
        INSERT INTO meter_usage (chain_id, meter, meter_id, total, issued_at, signature, period_start, period_used, calls, updated_at)
        VALUES (${chainId}, ${meter}, ${id}, ${input.total.toString()}, ${input.issuedAt.toString()}, ${input.signature},
                ${input.periodStart}, ${input.periodUsed.toString()}, 1, ${input.nowSeconds})
        ON CONFLICT (chain_id, meter, meter_id) DO UPDATE SET
          total = EXCLUDED.total, issued_at = EXCLUDED.issued_at, signature = EXCLUDED.signature,
          period_start = EXCLUDED.period_start, period_used = EXCLUDED.period_used,
          calls = meter_usage.calls + 1, updated_at = EXCLUDED.updated_at
        WHERE meter_usage.total = ${input.previous.toString()}
        RETURNING meter_id`;
      if (updated.length === 0) return false;
      await tx`
        INSERT INTO meter_calls (chain_id, meter, meter_id, total, amount, resource, at)
        VALUES (${chainId}, ${meter}, ${id}, ${input.total.toString()}, ${input.amount.toString()},
                ${input.resource ?? null}, ${input.nowSeconds})
        ON CONFLICT DO NOTHING`;
      return true;
    });
  }

  /** How many people have opened a meter paying `merchant` here, and whether `payer` is one of them. */
  async payersOf(merchant: Address, payer: Address): Promise<{ people: number; known: boolean }> {
    const [row] = await this.sql<{ people: string; known: boolean }[]>`
      SELECT count(DISTINCT lower(payer)) AS people, coalesce(bool_or(lower(payer) = ${payer.toLowerCase()}), false) AS known
      FROM meters
      WHERE chain_id = ${this.scope.chainId} AND meter = ${this.scope.meter} AND lower(merchant) = ${merchant.toLowerCase()}`;
    return { people: Number(row?.people ?? 0), known: row?.known ?? false };
  }

  /** The accepted total and period usage, to check a new receipt against. */
  async usage(id: bigint): Promise<{ total: bigint; periodStart: number; periodUsed: bigint } | undefined> {
    const rows = await this.sql<{ total: string; period_start: string; period_used: string }[]>`
      SELECT total, period_start, period_used FROM meter_usage
      WHERE chain_id = ${this.scope.chainId} AND meter = ${this.scope.meter} AND meter_id = ${id.toString()}`;
    const row = rows[0];
    return row === undefined ? undefined : { total: BigInt(row.total), periodStart: Number(row.period_start), periodUsed: BigInt(row.period_used) };
  }

  /**
   * Receipts worth settling: the accepted total is ahead of what is settled by at least
   * `minAmount`, or by anything once the last request is `maxAgeSeconds` old, and no settlement of
   * this total is in flight (or the one sent has had `retrySeconds` to land).
   */
  async toSettle(input: { minAmount: bigint; maxAgeSeconds: number; retrySeconds: number; nowSeconds: number; limit: number }) {
    return this.sql<{ meter_id: string; total: string; issued_at: string; signature: Hex; total_charged: string }[]>`
      SELECT u.meter_id, u.total, u.issued_at, u.signature, m.total_charged
      FROM meter_usage u
      JOIN meters m ON m.chain_id = u.chain_id AND m.meter = u.meter AND m.id = u.meter_id
      WHERE u.chain_id = ${this.scope.chainId} AND u.meter = ${this.scope.meter}
        AND u.total > m.total_charged
        AND (u.total - m.total_charged >= ${input.minAmount.toString()} OR u.updated_at <= ${input.nowSeconds - input.maxAgeSeconds})
        AND (u.settling_since IS NULL OR u.settling_total IS DISTINCT FROM u.total
             OR u.settling_since <= ${input.nowSeconds - input.retrySeconds})
      ORDER BY u.updated_at LIMIT ${input.limit}`;
  }

  async markSettling(id: bigint, total: bigint, nowSeconds: number): Promise<void> {
    await this.sql`
      UPDATE meter_usage SET settling_total = ${total.toString()}, settling_since = ${nowSeconds}
      WHERE chain_id = ${this.scope.chainId} AND meter = ${this.scope.meter} AND meter_id = ${id.toString()}`;
  }


}
