/**
 * The settler: turns accepted usage receipts into payments on chain, in batches.
 *
 * Every `pollMs` it finds meters whose accepted total is ahead of what is settled by at least
 * `minAmount`, or by anything once their last request is `maxAgeSeconds` old, and settles each
 * with its latest receipt through the relayer, which pays the fee. A receipt carries the whole
 * running total, so one settlement covers every request since the last one.
 *
 * A settlement in flight is not sent again until `retrySeconds` have passed without the indexer
 * seeing it land. A receipt the meter refuses with `NothingToSettle` (its period cap is used up)
 * waits the same way and goes again in a later period. Nothing here can overpay: the meter checks
 * the receipt's signature and every cap itself.
 */

import type { Hex } from "viem";

import type { MeterStore } from "../db/meters.js";
import { messageOf, type Logger } from "../log.js";
import { RejectedOnChainError } from "../relay/relayer.js";

export interface SettlerOptions {
  store: MeterStore;
  settle: (receipt: { meterId: bigint; total: bigint; issuedAt: bigint }, signature: Hex) => Promise<{ transaction: Hex }>;
  logger: Logger;
  /** Settle once this much is owed on a meter, in base units. */
  minAmount: bigint;
  /** Or once its last request is this old, whatever is owed. */
  maxAgeSeconds: number;
  /** A settlement sent is given this long to land before it is sent again. */
  retrySeconds?: number;
  pollMs?: number;
  batch?: number;
  now?: () => number;
}

export class MeterSettler {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopping = false;

  constructor(private readonly options: SettlerOptions) {}

  private now(): number {
    return (this.options.now ?? (() => Math.floor(Date.now() / 1000)))();
  }

  /** One pass. Returns how many settlements were sent. Public so tests can drive it. */
  async tick(): Promise<number> {
    const { store, logger } = this.options;
    const now = this.now();
    const due = await store.toSettle({
      minAmount: this.options.minAmount,
      maxAgeSeconds: this.options.maxAgeSeconds,
      retrySeconds: this.options.retrySeconds ?? 120,
      nowSeconds: now,
      limit: this.options.batch ?? 20,
    });
    let sent = 0;
    for (const row of due) {
      const meterId = BigInt(row.meter_id);
      const total = BigInt(row.total);
      try {
        const { transaction } = await this.options.settle({ meterId, total, issuedAt: BigInt(row.issued_at) }, row.signature);
        await store.markSettling(meterId, total, now);
        sent += 1;
        logger.info("meter settled", { meter: row.meter_id, total: row.total, owed: (total - BigInt(row.total_charged)).toString(), transaction });
      } catch (error) {
        // Refused by name (a cap reached for this period, the meter stopped before the receipt):
        // wait out the retry window rather than asking again every tick.
        if (error instanceof RejectedOnChainError) await store.markSettling(meterId, total, now);
        logger.warn("meter settlement deferred", { meter: row.meter_id, total: row.total, error: messageOf(error) });
      }
    }
    return sent;
  }

  start(): void {
    if (this.#timer !== undefined || this.#running !== undefined) return;
    this.#stopping = false;
    const loop = async () => {
      if (this.#stopping) return;
      this.#running = this.tick()
        .then(() => undefined)
        .catch((error: unknown) => this.options.logger.error("settler tick failed", { error: messageOf(error) }))
        .finally(() => {
          this.#running = undefined;
          if (!this.#stopping) this.#timer = setTimeout(() => void loop(), this.options.pollMs ?? 15_000);
        });
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}
