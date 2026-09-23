/**
 * Webhook delivery: POSTs queued events to merchants, with retries, and records every attempt.
 *
 * The indexer queues a delivery in the same transaction that first writes the event, so an event
 * is queued exactly once per merchant. This worker claims due deliveries (a short lease, `SKIP
 * LOCKED`, so two workers never send the same one at once), signs the stored body with the
 * merchant's secret at send time, and POSTs it to the merchant's current URL. A 2xx is delivered.
 * Anything else, a timeout or a redirect included, is retried after 10 seconds, a minute and five
 * minutes, then marked failed. The body never changes between attempts; the signature's `t` does.
 */

import type { Sql } from "../db/database.js";
import { messageOf, type Logger } from "../log.js";
import { SIGNATURE_HEADER, signWebhook } from "./sign.js";

export const DEFAULT_BACKOFF_MS: readonly number[] = [10_000, 60_000, 300_000];

export interface DispatcherOptions {
  sql: Sql;
  logger: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  /** Delay before each retry; its length is the number of retries after the first attempt. */
  backoffMs?: readonly number[];
  timeoutMs?: number;
  pollMs?: number;
  batch?: number;
}

interface Claimed {
  id: string;
  event_id: string;
  event_type: string;
  body: string;
  attempts: number;
  webhook_url: string | null;
  webhook_secret: string;
}

export interface AttemptResult {
  delivered: number;
  retried: number;
  failed: number;
}

const LEASE_MS = 60_000;

export class WebhookDispatcher {
  readonly #options: DispatcherOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #backoff: readonly number[];
  #stopping = false;
  #loop: Promise<void> | undefined;
  #wake: (() => void) | undefined;

  constructor(options: DispatcherOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  private async claim(): Promise<Claimed[]> {
    const now = this.#now();
    return this.#options.sql<Claimed[]>`
      UPDATE webhook_deliveries d SET next_attempt_ms = ${now + LEASE_MS}
      FROM merchants m
      WHERE m.id = d.merchant_id AND d.id IN (
        SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_ms <= ${now}
        ORDER BY next_attempt_ms, id
        LIMIT ${this.#options.batch ?? 20}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id, d.event_id, d.event_type, d.body, d.attempts, m.webhook_url, m.webhook_secret`;
  }

  private async post(delivery: Claimed, url: string): Promise<{ status?: number; error?: string }> {
    const timestamp = Math.floor(this.#now() / 1000);
    try {
      const response = await this.#fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Weir-Webhooks/1",
          [SIGNATURE_HEADER]: signWebhook(delivery.webhook_secret, delivery.body, timestamp),
        },
        body: delivery.body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 10_000),
      });
      // The receiver's body is never read into anything, only drained.
      await response.arrayBuffer().catch(() => undefined);
      return response.status >= 200 && response.status < 300 ? { status: response.status } : { status: response.status, error: `HTTP ${response.status}` };
    } catch (error) {
      return { error: messageOf(error).slice(0, 300) };
    }
  }

  /** Attempts every due delivery once. */
  async runOnce(): Promise<AttemptResult> {
    const { sql } = this.#options;
    const result: AttemptResult = { delivered: 0, retried: 0, failed: 0 };
    for (const delivery of await this.claim()) {
      const attempts = Number(delivery.attempts) + 1;
      const now = this.#now();
      if (delivery.webhook_url === null) {
        await sql`UPDATE webhook_deliveries SET status = 'failed', last_error = 'the webhook was removed', last_attempt_ms = ${now} WHERE id = ${delivery.id}`;
        result.failed += 1;
        continue;
      }
      const outcome = await this.post(delivery, delivery.webhook_url);
      const at = this.#now();
      if (outcome.error === undefined) {
        await sql`
          UPDATE webhook_deliveries SET status = 'delivered', attempts = ${attempts}, last_attempt_ms = ${at},
            delivered_ms = ${at}, last_url = ${delivery.webhook_url}, last_status = ${outcome.status ?? null}, last_error = NULL
          WHERE id = ${delivery.id}`;
        result.delivered += 1;
        continue;
      }
      const retryIn = this.#backoff[attempts - 1];
      await sql`
        UPDATE webhook_deliveries SET
          status = ${retryIn === undefined ? "failed" : "pending"},
          attempts = ${attempts},
          next_attempt_ms = ${retryIn === undefined ? at : at + retryIn},
          last_attempt_ms = ${at}, last_url = ${delivery.webhook_url},
          last_status = ${outcome.status ?? null}, last_error = ${outcome.error}
        WHERE id = ${delivery.id}`;
      if (retryIn === undefined) {
        result.failed += 1;
        this.#options.logger.warn("webhook failed for good", { event: delivery.event_id, attempts, error: outcome.error });
      } else {
        result.retried += 1;
      }
    }
    return result;
  }

  start(): void {
    if (this.#loop !== undefined) return;
    this.#stopping = false;
    const pollMs = this.#options.pollMs ?? 1_000;
    this.#loop = (async () => {
      while (!this.#stopping) {
        try {
          await this.runOnce();
        } catch (error) {
          this.#options.logger.error("webhook pass failed", { error: messageOf(error) });
        }
        await Promise.race([new Promise((resolve) => setTimeout(resolve, pollMs)), new Promise<void>((resolve) => (this.#wake = resolve))]);
      }
    })();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#wake?.();
    await this.#loop;
    this.#loop = undefined;
  }
}
