/**
 * The indexer: hub events into Postgres, from the deployment block to the head, about once a
 * second.
 *
 * ## A tick
 *
 * 1. Read the head from the RPC, always: "caught up" means caught up with the chain, not with an
 *    archive's copy of it.
 * 2. Choose the range. It starts after the cursor, or `reorgWindowBlocks` below the head when the
 *    cursor is that close, so the tip is read again every tick. That covers two things: a
 *    reorganisation, whose losing branch is removed (see `apply.ts`), and an RPC behind a load
 *    balancer whose backends lag the one that answered the head. Monad's public endpoint answers
 *    `eth_getLogs` past a backend's own head with an empty list, not an error, so a range read
 *    once from a lagging backend could otherwise pass over logs for good.
 * 3. Read it: from HyperSync in large chunks while the range ends more than `liveWindowBlocks`
 *    below the head, from the RPC in `logChunkBlocks` chunks otherwise, and from the RPC whenever
 *    HyperSync fails, in which case HyperSync is rested for a minute.
 * 4. Write it in one transaction with the cursor (`applyRange`).
 * 5. Refresh every mandate the range touched from `getMandate` at the indexed block, so each row
 *    is the chain's state as of the events stored. A backend that has not reached that block
 *    refuses the read rather than answering with older state, and the mandate stays marked.
 *
 * ## One indexer per hub
 *
 * The loop holds a Postgres advisory lock for its chain and hub. A second process (an API started
 * with the in-process indexer next to one started with `--indexer-only`) waits on the lock instead
 * of writing the same rows twice, and takes over if the first one dies.
 */

import type { MandateRecord } from "@weir/shared";
import type { Address } from "viem";

import type { Sql } from "../db/database.js";
import type { IndexScope } from "../db/store.js";
import { messageOf, type Logger } from "../log.js";
import { applyRange, mandatesToRefresh, type TimedLog } from "./apply.js";
import { decodeHubLog } from "./events.js";
import type { MandateReader } from "./reader.js";
import type { LogBatch, LogSource, RpcLogSource } from "./sources.js";

export interface IndexerOptions {
  sql: Sql;
  scope: IndexScope;
  startBlock: number;
  rpc: Pick<RpcLogSource, "name" | "head" | "getLogs" | "blockTime" | "blockHash" | "chunkBlocks">;
  hypersync?: LogSource;
  reader: MandateReader;
  symbolFor: (asset: Address) => string;
  logger: Logger;
  /** Blocks below the head read again every tick: reorganisations and lagging backends. */
  reorgWindowBlocks?: number;
  /** Ranges ending this close to the head are read from the RPC. */
  liveWindowBlocks?: number;
  hypersyncChunkBlocks?: number;
  pollMs?: number;
  /** Mandates refreshed per tick. */
  refreshBatch?: number;
  now?: () => number;
}

export interface TickReport {
  head: number;
  fromBlock: number;
  toBlock: number;
  source: "rpc" | "hypersync" | "none";
  logs: number;
  inserted: number;
  removed: number;
  deliveries: number;
  refreshed: number;
  caughtUp: boolean;
}

export interface IndexerStatus {
  running: boolean;
  /** True while another process holds this hub's indexer lock. */
  standingBy: boolean;
  head?: number;
  indexedBlock?: number;
  lag?: number;
  caughtUp: boolean;
  lastTickAt?: number;
  lastError?: string;
  source?: "rpc" | "hypersync";
}

export const DEFAULTS = {
  // Twenty seconds of Monad blocks, and still one `eth_getLogs` per tick at the head.
  reorgWindowBlocks: 50,
  liveWindowBlocks: 50,
  hypersyncChunkBlocks: 200_000,
  pollMs: 1_000,
  refreshBatch: 100,
  hypersyncRestMs: 60_000,
} as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Indexer {
  readonly status: IndexerStatus = { running: false, standingBy: false, caughtUp: false };
  readonly #options: IndexerOptions;
  readonly #reorgWindow: number;
  readonly #liveWindow: number;
  readonly #hypersyncChunk: number;
  readonly #now: () => number;
  #hypersyncRestingUntil = 0;
  #stopping = false;
  #loop: Promise<void> | undefined;
  #wake: (() => void) | undefined;

  constructor(options: IndexerOptions) {
    this.#options = options;
    this.#reorgWindow = options.reorgWindowBlocks ?? DEFAULTS.reorgWindowBlocks;
    this.#liveWindow = options.liveWindowBlocks ?? DEFAULTS.liveWindowBlocks;
    this.#hypersyncChunk = options.hypersyncChunkBlocks ?? DEFAULTS.hypersyncChunkBlocks;
    this.#now = options.now ?? Date.now;
  }

  private async cursor(): Promise<number | undefined> {
    const { sql, scope } = this.#options;
    const [row] = await sql<{ last_block: string }[]>`
      SELECT last_block FROM indexer_cursors WHERE chain_id = ${scope.chainId} AND hub = ${scope.hub}`;
    return row === undefined ? undefined : Number(row.last_block);
  }

  private async read(fromBlock: number, head: number): Promise<{ source: LogSource; toBlock: number; batch: LogBatch }> {
    const { rpc, hypersync, logger } = this.#options;
    const rpcTo = Math.min(head, fromBlock + rpc.chunkBlocks - 1);
    const archiveEdge = head - this.#liveWindow;
    const useArchive =
      hypersync !== undefined && this.#now() >= this.#hypersyncRestingUntil && fromBlock + rpc.chunkBlocks - 1 <= archiveEdge;

    if (useArchive) {
      const toBlock = Math.min(archiveEdge, fromBlock + this.#hypersyncChunk - 1);
      try {
        return { source: hypersync, toBlock, batch: await hypersync.getLogs(fromBlock, toBlock) };
      } catch (error) {
        this.#hypersyncRestingUntil = this.#now() + DEFAULTS.hypersyncRestMs;
        logger.warn("hypersync failed; reading the RPC for a minute", { fromBlock, toBlock, error: messageOf(error) });
      }
    }
    return { source: rpc, toBlock: rpcTo, batch: await rpc.getLogs(fromBlock, rpcTo) };
  }

  /** One pass. Public so tests can drive it. */
  async tick(): Promise<TickReport> {
    const { sql, scope, startBlock, rpc, symbolFor } = this.#options;
    const head = await rpc.head();
    const cursor = (await this.cursor()) ?? startBlock - 1;
    const fromBlock = Math.max(startBlock, Math.min(cursor + 1, head - this.#reorgWindow + 1));

    if (fromBlock > head) {
      const refreshed = await this.refresh(cursor);
      this.record(head, cursor, "rpc");
      return { head, fromBlock, toBlock: cursor, source: "none", logs: 0, inserted: 0, removed: 0, deliveries: 0, refreshed, caughtUp: true };
    }

    const { source, toBlock, batch } = await this.read(fromBlock, head);
    const entries: TimedLog[] = [];
    for (const log of batch.logs) {
      const event = decodeHubLog(log);
      if (event === undefined) continue;
      const blockTime = batch.blockTimes.get(log.blockNumber) ?? (await rpc.blockTime(log.blockNumber));
      entries.push({ log, event, blockTime });
    }

    const result = await applyRange(
      sql,
      { scope, symbolFor, nowMs: this.#now(), canonicalHash: (block) => rpc.blockHash(block) },
      { fromBlock, toBlock },
      entries,
    );
    const indexed = Math.max(cursor, toBlock);
    const refreshed = await this.refresh(indexed);
    this.record(head, indexed, source.name);

    if (result.inserted.length > 0 || result.removed > 0) {
      this.#options.logger.info("indexed", {
        from: fromBlock,
        to: toBlock,
        source: source.name,
        events: result.inserted.length,
        removed: result.removed,
        webhooks: result.deliveries,
      });
    }
    return {
      head,
      fromBlock,
      toBlock,
      source: source.name,
      logs: entries.length,
      inserted: result.inserted.length,
      removed: result.removed,
      deliveries: result.deliveries,
      refreshed,
      caughtUp: toBlock >= head,
    };
  }

  private record(head: number, indexed: number, source: "rpc" | "hypersync"): void {
    this.status.head = head;
    this.status.indexedBlock = indexed;
    this.status.lag = Math.max(0, head - indexed);
    this.status.caughtUp = indexed >= head;
    this.status.lastTickAt = Math.floor(this.#now() / 1000);
    this.status.source = source;
    delete this.status.lastError;
  }

  /**
   * Overwrites every marked mandate with `getMandate` as of `atBlock`. A read that fails, or a
   * mandate the node does not know yet, stays marked for the next tick. Returns how many were
   * refreshed.
   */
  async refresh(atBlock: number): Promise<number> {
    const { sql, scope, reader, logger } = this.#options;
    const ids = await mandatesToRefresh(sql, scope, this.#options.refreshBatch ?? DEFAULTS.refreshBatch);
    let refreshed = 0;
    for (let i = 0; i < ids.length; i += 8) {
      const slice = ids.slice(i, i + 8);
      const reads = await Promise.allSettled(slice.map((id) => reader.getMandate(id, atBlock)));
      for (const [index, read] of reads.entries()) {
        if (read.status === "rejected") {
          logger.warn("mandate refresh deferred", { mandate: slice[index], atBlock, error: messageOf(read.reason) });
          continue;
        }
        if (read.value === undefined) continue;
        await writeRecord(sql, scope, read.value, Math.floor(this.#now() / 1000));
        refreshed += 1;
      }
    }
    return refreshed;
  }

  /** Runs ticks until {@link stop}: back to back while catching up, every `pollMs` at the head. */
  start(): void {
    if (this.#loop !== undefined) return;
    this.#stopping = false;
    this.status.running = true;
    this.#loop = this.run().finally(() => {
      this.status.running = false;
    });
  }

  private async pause(ms: number): Promise<void> {
    await Promise.race([sleep(ms), new Promise<void>((resolve) => (this.#wake = resolve))]);
    this.#wake = undefined;
  }

  private async run(): Promise<void> {
    const { sql, scope, logger } = this.#options;
    const pollMs = this.#options.pollMs ?? DEFAULTS.pollMs;
    const reserved = await sql.reserve();
    try {
      while (!this.#stopping) {
        const [lock] = await reserved<{ ok: boolean }[]>`
          SELECT pg_try_advisory_lock(hashtext(current_schema() || ':indexer:' || ${scope.chainId} || ':' || ${scope.hub})) AS ok`;
        if (lock?.ok === true) {
          if (this.status.standingBy) logger.info("the other indexer let go; indexing from here");
          break;
        }
        if (!this.status.standingBy) logger.warn("another process is indexing this hub; standing by");
        this.status.standingBy = true;
        await this.pause(5_000);
      }
      this.status.standingBy = false;

      let failures = 0;
      while (!this.#stopping) {
        try {
          const report = await this.tick();
          failures = 0;
          if (report.caughtUp) await this.pause(pollMs);
        } catch (error) {
          failures += 1;
          this.status.lastError = messageOf(error);
          logger.error("indexer tick failed", { error: messageOf(error), failures });
          await this.pause(Math.min(30_000, pollMs * 2 ** Math.min(failures, 5)));
        }
      }
    } finally {
      await reserved`SELECT pg_advisory_unlock_all()`.catch(() => undefined);
      reserved.release();
    }
  }

  /** Stops after the tick in flight. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#wake?.();
    await this.#loop;
    this.#loop = undefined;
  }
}

async function writeRecord(sql: Sql, scope: IndexScope, m: MandateRecord, nowSeconds: number): Promise<void> {
  await sql`
    UPDATE mandates SET
      payer = ${m.payer}, merchant = ${m.merchant}, asset = ${m.asset}, vault = ${m.vault}, manager = ${m.manager},
      amount = ${m.amount.toString()}, period = ${m.period}, next_charge_at = ${m.nextChargeAt.toString()},
      max_per_charge = ${m.maxPerCharge.toString()}, max_total = ${m.maxTotal.toString()},
      total_charged = ${m.totalCharged.toString()}, expires_at = ${m.expiresAt.toString()},
      paused_at = ${m.pausedAt.toString()}, status = ${m.status}, needs_refresh = false, refreshed_at = ${nowSeconds}
    WHERE chain_id = ${scope.chainId} AND hub = ${scope.hub} AND id = ${m.id.toString()}`;
}
