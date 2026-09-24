/**
 * Writing one range of logs into the index, atomically.
 *
 * ## Idempotent on (tx hash, log index)
 *
 * `hub_events` is keyed by where a log sits, so reading a range twice inserts nothing the second
 * time, and only a log inserted for the first time is applied to its mandate and handed to the
 * webhooks. Restarting, re-running from an earlier block, and the re-scan window all converge on
 * the same rows and never deliver an event twice.
 *
 * ## Reorganisations
 *
 * A stored event in the range that did not come back is removed only once the chain confirms its
 * block was replaced: the canonical hash at that height differs from the one stored. An empty
 * answer from a backend that is merely behind proves nothing, so without that confirmation the
 * event stays. A confirmed removal deletes the event with its charge, and a mandate whose creation
 * it was. An event that came back under a different block hash was re-mined: its block fields
 * move. Either way the mandate is marked for refresh.
 *
 * ## Applying an event
 *
 * Each event writes what it says (a charge's new total and schedule, a cancellation, a pause
 * moment, a new manager) and marks the mandate `needs_refresh`. The indexer then reads the row
 * back from `getMandate`, so the stored state is exactly the chain's even where an event does not
 * carry a field it changed (a resume shifts the checkpoint, for one).
 */

import type { ChargeView } from "@weir/shared";
import type { Address } from "viem";

import type { Db, Sql } from "../db/database.js";
import { selectMandateRows, type IndexScope } from "../db/store.js";
import { toMandateView } from "../domain/views.js";
import { argsJson, eventId, mandateIdOf, type DecodedLog, type HubEvent } from "./events.js";

export interface TimedLog extends DecodedLog {
  blockTime: number;
}

export interface ApplyResult {
  /** Events written for the first time, in chain order. */
  inserted: TimedLog[];
  /** Stored events the range no longer contains. */
  removed: number;
  /** Stored events whose block was re-mined. */
  moved: number;
  /** Webhook deliveries queued. */
  deliveries: number;
}

/** The webhook event type for a hub event; `undefined` for events merchants are not told about. */
export const WEBHOOK_TYPES: Partial<Record<HubEvent["eventName"], string>> = {
  MandateCreated: "mandate.created",
  Charged: "charge.succeeded",
  ChargeFailed: "charge.failed",
  MandateCancelled: "mandate.cancelled",
  MandatePaused: "mandate.paused",
  MandateResumed: "mandate.resumed",
};

export interface ApplyContext {
  scope: IndexScope;
  symbolFor: (asset: Address) => string;
  nowMs: number;
  /** The canonical block hash at a height, or `undefined` when the node has not reached it. */
  canonicalHash: (blockNumber: number) => Promise<string | undefined>;
}

async function applyEvent(tx: Db, scope: IndexScope, entry: TimedLog): Promise<void> {
  const { event, log, blockTime } = entry;
  const id = mandateIdOf(event).toString();
  const key = { chain: scope.chainId, hub: scope.hub };

  switch (event.eventName) {
    case "MandateCreated": {
      const a = event.args;
      await tx`
        INSERT INTO mandates (chain_id, hub, id, payer, merchant, asset, vault, manager, amount, period, next_charge_at,
                              max_per_charge, max_total, total_charged, expires_at, paused_at, status, ref,
                              created_at, created_block, created_tx, needs_refresh)
        VALUES (${key.chain}, ${key.hub}, ${id}, ${a.payer}, ${a.merchant}, ${a.asset}, ${a.vault}, ${a.manager},
                ${a.amount.toString()}, ${a.period}, ${a.nextChargeAt.toString()}, ${a.maxPerCharge.toString()},
                ${a.maxTotal.toString()}, 0, ${a.expiresAt.toString()}, 0, 'Active', ${a.ref.toLowerCase()},
                ${blockTime}, ${log.blockNumber}, ${log.transactionHash}, true)
        ON CONFLICT (chain_id, hub, id) DO UPDATE SET
          payer = EXCLUDED.payer, merchant = EXCLUDED.merchant, asset = EXCLUDED.asset, vault = EXCLUDED.vault,
          ref = EXCLUDED.ref, created_at = EXCLUDED.created_at, created_block = EXCLUDED.created_block,
          created_tx = EXCLUDED.created_tx, needs_refresh = true`;
      return;
    }
    case "Charged": {
      const a = event.args;
      await tx`
        INSERT INTO charges (chain_id, hub, tx_hash, log_index, block_number, block_time, mandate_id, kind, amount, reason)
        VALUES (${key.chain}, ${key.hub}, ${log.transactionHash}, ${log.logIndex}, ${log.blockNumber}, ${blockTime}, ${id},
                'charged', ${a.amount.toString()}, NULL)
        ON CONFLICT DO NOTHING`;
      await tx`
        UPDATE mandates SET total_charged = ${a.totalCharged.toString()}, next_charge_at = ${a.nextChargeAt.toString()},
          status = CASE WHEN status = 'Cancelled' THEN status ELSE 'Active' END, needs_refresh = true
        WHERE chain_id = ${key.chain} AND hub = ${key.hub} AND id = ${id}`;
      return;
    }
    case "ChargeFailed": {
      const a = event.args;
      await tx`
        INSERT INTO charges (chain_id, hub, tx_hash, log_index, block_number, block_time, mandate_id, kind, amount, reason)
        VALUES (${key.chain}, ${key.hub}, ${log.transactionHash}, ${log.logIndex}, ${log.blockNumber}, ${blockTime}, ${id},
                'failed', ${a.required.toString()}, ${a.reason})
        ON CONFLICT DO NOTHING`;
      await tx`
        UPDATE mandates SET status = CASE WHEN status = 'Cancelled' THEN status ELSE 'Delinquent' END, needs_refresh = true
        WHERE chain_id = ${key.chain} AND hub = ${key.hub} AND id = ${id}`;
      return;
    }
    case "MandateCancelled":
      await tx`UPDATE mandates SET status = 'Cancelled', needs_refresh = true WHERE chain_id = ${key.chain} AND hub = ${key.hub} AND id = ${id}`;
      return;
    case "MandatePaused":
      await tx`UPDATE mandates SET paused_at = ${blockTime}, needs_refresh = true WHERE chain_id = ${key.chain} AND hub = ${key.hub} AND id = ${id}`;
      return;
    case "MandateResumed":
      await tx`UPDATE mandates SET paused_at = 0, needs_refresh = true WHERE chain_id = ${key.chain} AND hub = ${key.hub} AND id = ${id}`;
      return;
    case "ManagerChanged":
      await tx`UPDATE mandates SET manager = ${event.args.manager}, needs_refresh = true WHERE chain_id = ${key.chain} AND hub = ${key.hub} AND id = ${id}`;
      return;
  }
}

/** Queues the event for every merchant paid by this mandate that has a webhook set since before it. */
async function enqueueWebhooks(tx: Db, context: ApplyContext, entry: TimedLog): Promise<number> {
  const type = WEBHOOK_TYPES[entry.event.eventName];
  if (type === undefined) return 0;
  const { scope } = context;
  const mandateId = mandateIdOf(entry.event);

  const recipients = await tx<{ id: string }[]>`
    SELECT DISTINCT mer.id
    FROM mandates m
    JOIN merchant_payouts mp ON mp.address = m.merchant
    JOIN merchants mer ON mer.id = mp.merchant_id
    WHERE m.chain_id = ${scope.chainId} AND m.hub = ${scope.hub} AND m.id = ${mandateId.toString()}
      AND mer.webhook_url IS NOT NULL AND mer.webhook_since <= ${entry.blockTime}`;
  if (recipients.length === 0) return 0;

  const [row] = await selectMandateRows(tx, scope, { mandateId }, 1);
  if (row === undefined) return 0;
  const mandate = toMandateView(row, context.symbolFor(row.asset), entry.blockTime);

  let charge: ChargeView | undefined;
  if (entry.event.eventName === "Charged" || entry.event.eventName === "ChargeFailed") {
    const failed = entry.event.eventName === "ChargeFailed";
    charge = {
      mandateId: mandateId.toString(),
      kind: failed ? "failed" : "charged",
      amount: (entry.event.eventName === "ChargeFailed" ? entry.event.args.required : entry.event.args.amount).toString(),
      ...(entry.event.eventName === "ChargeFailed" ? { reason: entry.event.args.reason } : {}),
      merchant: mandate.merchant,
      payer: mandate.payer,
      asset: mandate.asset,
      timestamp: entry.blockTime,
      blockNumber: entry.log.blockNumber,
      transaction: entry.log.transactionHash,
    };
  }

  const id = eventId(scope.chainId, entry.log);
  const body = JSON.stringify({
    id,
    type,
    createdAt: entry.blockTime,
    chainId: scope.chainId,
    hub: scope.hub,
    data: {
      mandate,
      ...(charge === undefined ? {} : { charge }),
      transaction: entry.log.transactionHash,
      blockNumber: entry.log.blockNumber,
      logIndex: entry.log.logIndex,
    },
  });

  let queued = 0;
  for (const recipient of recipients) {
    const inserted = await tx`
      INSERT INTO webhook_deliveries (merchant_id, event_id, event_type, body, next_attempt_ms, created_ms)
      VALUES (${recipient.id}, ${id}, ${type}, ${body}, ${context.nowMs}, ${context.nowMs})
      ON CONFLICT (merchant_id, event_id) DO NOTHING
      RETURNING id`;
    queued += inserted.length;
  }
  return queued;
}

/**
 * Writes the logs of `[fromBlock, toBlock]` and advances the cursor to at least `toBlock`, in one
 * transaction. `entries` must be every watched log in the range, in chain order.
 */
export async function applyRange(
  sql: Sql,
  context: ApplyContext,
  range: { fromBlock: number; toBlock: number },
  entries: readonly TimedLog[],
): Promise<ApplyResult> {
  const { scope } = context;
  return sql.begin(async (tx) => {
    const key = (txHash: string, logIndex: number): string => `${txHash.toLowerCase()}:${logIndex}`;
    const fetched = new Map(entries.map((entry) => [key(entry.log.transactionHash, entry.log.logIndex), entry]));

    const stored = await tx<{ tx_hash: string; log_index: number; event: string; mandate_id: string; block_number: string; block_hash: string }[]>`
      SELECT tx_hash, log_index, event, mandate_id, block_number, block_hash FROM hub_events
      WHERE chain_id = ${scope.chainId} AND hub = ${scope.hub}
        AND block_number BETWEEN ${range.fromBlock} AND ${range.toBlock}`;

    const canonical = new Map<number, string | undefined>();
    let removed = 0;
    for (const row of stored) {
      if (fetched.has(key(row.tx_hash, row.log_index))) continue;
      const height = Number(row.block_number);
      if (!canonical.has(height)) canonical.set(height, (await context.canonicalHash(height))?.toLowerCase());
      const hash = canonical.get(height);
      if (hash === undefined || hash === row.block_hash) continue;
      removed += 1;
      await tx`DELETE FROM hub_events WHERE chain_id = ${scope.chainId} AND tx_hash = ${row.tx_hash} AND log_index = ${row.log_index}`;
      if (row.event === "MandateCreated") {
        await tx`DELETE FROM mandates WHERE chain_id = ${scope.chainId} AND hub = ${scope.hub} AND id = ${row.mandate_id} AND created_tx = ${row.tx_hash}`;
      }
      await tx`UPDATE mandates SET needs_refresh = true WHERE chain_id = ${scope.chainId} AND hub = ${scope.hub} AND id = ${row.mandate_id}`;
    }

    const inserted: TimedLog[] = [];
    let moved = 0;
    let deliveries = 0;
    for (const entry of entries) {
      const { log, event, blockTime } = entry;
      const [written] = await tx<{ inserted: boolean }[]>`
        INSERT INTO hub_events (chain_id, hub, tx_hash, log_index, block_number, block_hash, block_time, event, mandate_id, args)
        VALUES (${scope.chainId}, ${scope.hub}, ${log.transactionHash}, ${log.logIndex}, ${log.blockNumber}, ${log.blockHash},
                ${blockTime}, ${event.eventName}, ${mandateIdOf(event).toString()}, ${tx.json(argsJson(event))})
        ON CONFLICT (chain_id, tx_hash, log_index) DO UPDATE SET
          block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash, block_time = EXCLUDED.block_time
        WHERE hub_events.block_hash <> EXCLUDED.block_hash
        RETURNING (xmax = 0) AS inserted`;
      if (written === undefined) continue;

      if (!written.inserted) {
        moved += 1;
        await tx`UPDATE charges SET block_number = ${log.blockNumber}, block_time = ${blockTime}
                 WHERE chain_id = ${scope.chainId} AND tx_hash = ${log.transactionHash} AND log_index = ${log.logIndex}`;
        await tx`UPDATE mandates SET needs_refresh = true,
                   created_block = CASE WHEN created_tx = ${log.transactionHash} THEN ${log.blockNumber} ELSE created_block END,
                   created_at = CASE WHEN created_tx = ${log.transactionHash} THEN ${blockTime} ELSE created_at END
                 WHERE chain_id = ${scope.chainId} AND hub = ${scope.hub} AND id = ${mandateIdOf(event).toString()}`;
        continue;
      }

      await applyEvent(tx, scope, entry);
      deliveries += await enqueueWebhooks(tx, context, entry);
      inserted.push(entry);
    }

    await tx`
      INSERT INTO indexer_cursors (chain_id, hub, last_block, updated_at)
      VALUES (${scope.chainId}, ${scope.hub}, ${range.toBlock}, ${Math.floor(context.nowMs / 1000)})
      ON CONFLICT (chain_id, hub) DO UPDATE SET
        last_block = GREATEST(indexer_cursors.last_block, EXCLUDED.last_block), updated_at = EXCLUDED.updated_at`;

    return { inserted, removed, moved, deliveries };
  });
}

/** Mandates waiting for a `getMandate` read, oldest id first. */
export async function mandatesToRefresh(sql: Db, scope: IndexScope, limit: number): Promise<bigint[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM mandates WHERE chain_id = ${scope.chainId} AND hub = ${scope.hub} AND needs_refresh
    ORDER BY id LIMIT ${limit}`;
  return rows.map((row) => BigInt(row.id));
}
