/**
 * The meter's track: `MandateMeter` events into `meters` and `meter_settlements`, on the same loop
 * as the hub's (see `indexer.ts`), with the same guarantees.
 *
 * - Idempotent on (tx hash, log index): `meter_events` is keyed by where a log sits, so a range
 *   read twice inserts nothing the second time, and only a new log is applied or sent to a webhook.
 * - Reorganisations: a stored event that did not come back is removed only once the chain confirms
 *   its block was replaced, exactly as for the hub; its settlement goes with it (cascade), and a
 *   meter whose creation it was is removed.
 * - Each event writes what it says and marks the meter; the refresh then overwrites the row from
 *   `getMeter` at the indexed block, so the stored meter is exactly the chain's.
 */

import { mandateMeterAbi, type MeterStatus, type MeterView } from "@weir/shared";
import {
  decodeEventLog,
  getAbiItem,
  getAddress,
  toEventSelector,
  zeroAddress,
  type AbiEvent,
  type Address,
  type DecodeEventLogReturnType,
  type Hex,
  type PublicClient,
} from "viem";

import type { Db, Sql } from "../db/database.js";
import type { MeterStore } from "../db/meters.js";
import { messageOf, type Logger } from "../log.js";
import { eventId, type RawLog } from "./events.js";
import type { IndexTrack, TrackEntry } from "./indexer.js";

export const METER_EVENTS = ["MeterCreated", "UsageSettled", "SettleFailed", "MeterCancelled"] as const;

export type MeterEvent = Extract<DecodeEventLogReturnType<typeof mandateMeterAbi>, { eventName: (typeof METER_EVENTS)[number] }>;

export const METER_TOPICS: readonly Hex[] = METER_EVENTS.map((name) =>
  toEventSelector(getAbiItem({ abi: mandateMeterAbi, name }) as AbiEvent),
);

const WATCHED = new Set<string>(METER_EVENTS);

export function decodeMeterLog(log: RawLog): MeterEvent | undefined {
  const [topic0, ...rest] = log.topics;
  if (topic0 === undefined || !METER_TOPICS.includes(topic0)) return undefined;
  try {
    const decoded = decodeEventLog({ abi: mandateMeterAbi, data: log.data, topics: [topic0, ...rest], strict: true });
    return WATCHED.has(decoded.eventName) ? (decoded as MeterEvent) : undefined;
  } catch {
    return undefined;
  }
}

/** What merchants are told, by event. */
export const METER_WEBHOOK_TYPES: Record<MeterEvent["eventName"], string> = {
  MeterCreated: "meter.created",
  UsageSettled: "meter.settled",
  SettleFailed: "meter.settle_failed",
  MeterCancelled: "meter.cancelled",
};

const STATUSES: readonly MeterStatus[] = ["Active", "Delinquent", "Cancelled"];

export interface MeterRecord {
  id: bigint;
  payer: Address;
  merchant: Address;
  asset: Address;
  manager: Address;
  periodCap: bigint;
  period: number;
  maxTotal: bigint;
  expiresAt: bigint;
  status: MeterStatus;
  totalCharged: bigint;
  closedAt: bigint;
}

export interface MeterReader {
  /** The meter as of `blockNumber`, or `undefined` when it does not exist there. */
  getMeter(id: bigint, blockNumber?: number): Promise<MeterRecord | undefined>;
}

export function createMeterReader(client: PublicClient, meter: Address): MeterReader {
  return {
    async getMeter(id, blockNumber) {
      const m = await client.readContract({
        address: meter,
        abi: mandateMeterAbi,
        functionName: "getMeter",
        args: [id],
        ...(blockNumber === undefined ? {} : { blockNumber: BigInt(blockNumber) }),
      });
      if (m.payer === zeroAddress) return undefined;
      const status = STATUSES[m.status];
      if (status === undefined) throw new RangeError(`No meter status has index ${m.status}`);
      return {
        id,
        payer: m.payer,
        merchant: m.merchant,
        asset: m.asset,
        manager: m.manager,
        periodCap: m.periodCap,
        period: m.period,
        maxTotal: m.maxTotal,
        expiresAt: m.expiresAt,
        status,
        totalCharged: m.totalCharged,
        closedAt: m.closedAt,
      };
    },
  };
}

function argsJson(event: MeterEvent): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(event.args as Record<string, unknown>)) {
    if (typeof value === "bigint") out[key] = value.toString();
    else if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) out[key] = getAddress(value);
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else out[key] = String(value);
  }
  return out;
}

async function applyEvent(tx: Db, chainId: number, meter: Address, entry: TrackEntry<MeterEvent>): Promise<void> {
  const { event, log, blockTime } = entry;
  const id = event.args.meterId.toString();
  switch (event.eventName) {
    case "MeterCreated": {
      const a = event.args;
      await tx`
        INSERT INTO meters (chain_id, meter, id, payer, merchant, asset, manager, period_cap, period, max_total, expires_at, ref,
                            status, total_charged, closed_at, created_at, created_block, created_tx, needs_refresh)
        VALUES (${chainId}, ${meter}, ${id}, ${a.payer}, ${a.merchant}, ${a.asset}, ${a.manager}, ${a.periodCap.toString()},
                ${a.period}, ${a.maxTotal.toString()}, ${a.expiresAt.toString()}, ${a.ref.toLowerCase()}, 'Active', 0, 0,
                ${blockTime}, ${log.blockNumber}, ${log.transactionHash}, true)
        ON CONFLICT (chain_id, meter, id) DO UPDATE SET
          payer = EXCLUDED.payer, merchant = EXCLUDED.merchant, asset = EXCLUDED.asset, manager = EXCLUDED.manager,
          ref = EXCLUDED.ref, created_at = EXCLUDED.created_at, created_block = EXCLUDED.created_block,
          created_tx = EXCLUDED.created_tx, needs_refresh = true`;
      return;
    }
    case "UsageSettled": {
      const a = event.args;
      await tx`
        INSERT INTO meter_settlements (chain_id, meter, tx_hash, log_index, block_number, block_time, meter_id, kind, amount, receipt_total, reason)
        VALUES (${chainId}, ${meter}, ${log.transactionHash}, ${log.logIndex}, ${log.blockNumber}, ${blockTime}, ${id},
                'settled', ${a.amount.toString()}, ${a.receiptTotal.toString()}, NULL)
        ON CONFLICT DO NOTHING`;
      await tx`
        UPDATE meters SET total_charged = GREATEST(total_charged, ${a.totalCharged.toString()}),
          status = CASE WHEN status = 'Cancelled' THEN status ELSE 'Active' END, needs_refresh = true
        WHERE chain_id = ${chainId} AND meter = ${meter} AND id = ${id}`;
      return;
    }
    case "SettleFailed": {
      const a = event.args;
      await tx`
        INSERT INTO meter_settlements (chain_id, meter, tx_hash, log_index, block_number, block_time, meter_id, kind, amount, receipt_total, reason)
        VALUES (${chainId}, ${meter}, ${log.transactionHash}, ${log.logIndex}, ${log.blockNumber}, ${blockTime}, ${id},
                'failed', ${a.required.toString()}, NULL, ${a.reason})
        ON CONFLICT DO NOTHING`;
      await tx`
        UPDATE meters SET status = CASE WHEN status = 'Cancelled' THEN status ELSE 'Delinquent' END, needs_refresh = true
        WHERE chain_id = ${chainId} AND meter = ${meter} AND id = ${id}`;
      return;
    }
    case "MeterCancelled":
      await tx`
        UPDATE meters SET status = 'Cancelled', closed_at = ${blockTime}, needs_refresh = true
        WHERE chain_id = ${chainId} AND meter = ${meter} AND id = ${id}`;
      return;
  }
}

export interface MeterTrackOptions {
  sql: Sql;
  chainId: number;
  meter: Address;
  reader: MeterReader;
  store: MeterStore;
  logger: Logger;
  refreshBatch?: number;
}

export function meterTrack(options: MeterTrackOptions): IndexTrack<MeterEvent> {
  const { sql, chainId, meter, reader, store, logger } = options;

  /** Queues the event for every business whose proven payout wallet the meter pays. */
  async function enqueueWebhooks(tx: Db, entry: TrackEntry<MeterEvent>, nowMs: number): Promise<number> {
    const id = entry.event.args.meterId;
    const recipients = await tx<{ id: string }[]>`
      SELECT DISTINCT mer.id
      FROM meters m
      JOIN merchant_payouts mp ON mp.address = m.merchant
      JOIN merchants mer ON mer.id = mp.merchant_id
      WHERE m.chain_id = ${chainId} AND m.meter = ${meter} AND m.id = ${id.toString()}
        AND mer.webhook_url IS NOT NULL AND mer.webhook_since <= ${entry.blockTime}`;
    if (recipients.length === 0) return 0;
    const view: MeterView | undefined = await store.meter(id, entry.blockTime, tx);
    if (view === undefined) return 0;

    const type = METER_WEBHOOK_TYPES[entry.event.eventName];
    const eid = eventId(chainId, entry.log);
    const body = JSON.stringify({
      id: eid,
      type,
      createdAt: entry.blockTime,
      chainId,
      meter,
      data: {
        meter: view,
        event: argsJson(entry.event),
        transaction: entry.log.transactionHash,
        blockNumber: entry.log.blockNumber,
        logIndex: entry.log.logIndex,
      },
    });
    let queued = 0;
    for (const recipient of recipients) {
      const inserted = await tx`
        INSERT INTO webhook_deliveries (merchant_id, event_id, event_type, body, next_attempt_ms, created_ms)
        VALUES (${recipient.id}, ${eid}, ${type}, ${body}, ${nowMs}, ${nowMs})
        ON CONFLICT (merchant_id, event_id) DO NOTHING
        RETURNING id`;
      queued += inserted.length;
    }
    return queued;
  }

  return {
    decode: decodeMeterLog,

    async apply(range, entries, context) {
      return sql.begin(async (tx) => {
        const key = (txHash: string, logIndex: number) => `${txHash.toLowerCase()}:${logIndex}`;
        const fetched = new Set(entries.map((entry) => key(entry.log.transactionHash, entry.log.logIndex)));

        const stored = await tx<{ tx_hash: string; log_index: number; event: string; meter_id: string; block_number: string; block_hash: string }[]>`
          SELECT tx_hash, log_index, event, meter_id, block_number, block_hash FROM meter_events
          WHERE chain_id = ${chainId} AND meter = ${meter} AND block_number BETWEEN ${range.fromBlock} AND ${range.toBlock}`;
        const canonical = new Map<number, string | undefined>();
        let removed = 0;
        for (const row of stored) {
          if (fetched.has(key(row.tx_hash, row.log_index))) continue;
          const height = Number(row.block_number);
          if (!canonical.has(height)) canonical.set(height, (await context.canonicalHash(height))?.toLowerCase());
          const hash = canonical.get(height);
          if (hash === undefined || hash === row.block_hash) continue;
          removed += 1;
          await tx`DELETE FROM meter_events WHERE chain_id = ${chainId} AND tx_hash = ${row.tx_hash} AND log_index = ${row.log_index}`;
          if (row.event === "MeterCreated") {
            await tx`DELETE FROM meters WHERE chain_id = ${chainId} AND meter = ${meter} AND id = ${row.meter_id} AND created_tx = ${row.tx_hash}`;
          }
          await tx`UPDATE meters SET needs_refresh = true WHERE chain_id = ${chainId} AND meter = ${meter} AND id = ${row.meter_id}`;
        }

        let inserted = 0;
        let deliveries = 0;
        for (const entry of entries) {
          const { log, event, blockTime } = entry;
          const [written] = await tx<{ inserted: boolean }[]>`
            INSERT INTO meter_events (chain_id, meter, tx_hash, log_index, block_number, block_hash, block_time, event, meter_id, args)
            VALUES (${chainId}, ${meter}, ${log.transactionHash}, ${log.logIndex}, ${log.blockNumber}, ${log.blockHash},
                    ${blockTime}, ${event.eventName}, ${event.args.meterId.toString()}, ${tx.json(argsJson(event))})
            ON CONFLICT (chain_id, tx_hash, log_index) DO UPDATE SET
              block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash, block_time = EXCLUDED.block_time
            WHERE meter_events.block_hash <> EXCLUDED.block_hash
            RETURNING (xmax = 0) AS inserted`;
          if (written === undefined) continue;
          if (!written.inserted) {
            await tx`UPDATE meter_settlements SET block_number = ${log.blockNumber}, block_time = ${blockTime}
                     WHERE chain_id = ${chainId} AND tx_hash = ${log.transactionHash} AND log_index = ${log.logIndex}`;
            await tx`UPDATE meters SET needs_refresh = true,
                       created_block = CASE WHEN created_tx = ${log.transactionHash} THEN ${log.blockNumber} ELSE created_block END,
                       created_at = CASE WHEN created_tx = ${log.transactionHash} THEN ${blockTime} ELSE created_at END
                     WHERE chain_id = ${chainId} AND meter = ${meter} AND id = ${event.args.meterId.toString()}`;
            continue;
          }
          await applyEvent(tx, chainId, meter, entry);
          deliveries += await enqueueWebhooks(tx, entry, context.nowMs);
          inserted += 1;
        }

        await tx`
          INSERT INTO indexer_cursors (chain_id, hub, last_block, updated_at)
          VALUES (${chainId}, ${meter}, ${range.toBlock}, ${Math.floor(context.nowMs / 1000)})
          ON CONFLICT (chain_id, hub) DO UPDATE SET
            last_block = GREATEST(indexer_cursors.last_block, EXCLUDED.last_block), updated_at = EXCLUDED.updated_at`;
        return { inserted, removed, deliveries };
      });
    },

    async refresh(atBlock) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM meters WHERE chain_id = ${chainId} AND meter = ${meter} AND needs_refresh
        ORDER BY id LIMIT ${options.refreshBatch ?? 100}`;
      let refreshed = 0;
      for (const row of rows) {
        let record: MeterRecord | undefined;
        try {
          record = await reader.getMeter(BigInt(row.id), atBlock);
        } catch (error) {
          logger.warn("meter refresh deferred", { meter: row.id, atBlock, error: messageOf(error) });
          continue;
        }
        if (record === undefined) continue;
        await sql`
          UPDATE meters SET
            payer = ${record.payer}, merchant = ${record.merchant}, asset = ${record.asset}, manager = ${record.manager},
            period_cap = ${record.periodCap.toString()}, period = ${record.period}, max_total = ${record.maxTotal.toString()},
            expires_at = ${record.expiresAt.toString()}, status = ${record.status}, total_charged = ${record.totalCharged.toString()},
            closed_at = ${record.closedAt.toString()}, needs_refresh = false, refreshed_at = ${Math.floor(Date.now() / 1000)}
          WHERE chain_id = ${chainId} AND meter = ${meter} AND id = ${row.id}`;
        refreshed += 1;
      }
      return refreshed;
    },
  };
}
