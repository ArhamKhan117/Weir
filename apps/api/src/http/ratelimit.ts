/**
 * Token-bucket rate limits, in memory.
 *
 * Each key (an IP, a payer) holds a bucket of `capacity` tokens refilling evenly over `windowMs`,
 * so a burst of `capacity` is allowed and the sustained rate is `capacity` per window. A refusal
 * says exactly how long until the next token, which becomes the `retry-after` header.
 *
 * In memory because the API is one process. Full buckets are forgotten, so the map holds only keys
 * that were busy recently.
 */

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RateLimitOptions {
  capacity: number;
  windowMs: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #perMs: number;
  readonly #now: () => number;

  constructor(options: RateLimitOptions) {
    if (options.capacity < 1 || options.windowMs <= 0) throw new RangeError("a rate limit needs a capacity and a window");
    this.#capacity = options.capacity;
    this.#perMs = options.capacity / options.windowMs;
    this.#now = options.now ?? Date.now;
  }

  private refill(bucket: Bucket, now: number): void {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsed * this.#perMs);
    bucket.updatedAt = now;
  }

  /** Spends one token for `key`, or says how long until one is available. */
  take(key: string): RateDecision {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, updatedAt: now };
    this.refill(bucket, now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.#buckets.set(key, bucket);
      this.prune(now);
      return { ok: true };
    }
    this.#buckets.set(key, bucket);
    return { ok: false, retryAfterSeconds: Math.ceil((1 - bucket.tokens) / this.#perMs / 1000) };
  }

  /** Buckets currently held, for tests. */
  get size(): number {
    return this.#buckets.size;
  }

  private prune(now: number): void {
    if (this.#buckets.size < 10_000) return;
    for (const [key, bucket] of this.#buckets) {
      this.refill(bucket, now);
      if (bucket.tokens >= this.#capacity) this.#buckets.delete(key);
    }
  }
}

/** The limits the API applies. Tunable in code, not in the environment. */
export const RATE_LIMITS = {
  /** Every relay route, per client IP. */
  relayPerIp: { capacity: 30, windowMs: 60_000 },
  /** Installs, per payer address. */
  installPerPayer: { capacity: 6, windowMs: 10 * 60_000 },
  /** Savings moves, per owner: each is a transaction the relayer pays for. */
  savingsPerOwner: { capacity: 10, windowMs: 10 * 60_000 },
  /** Payouts, per business: each is two transactions the relayer pays for. */
  payoutsPerMerchant: { capacity: 6, windowMs: 10 * 60_000 },
  /** Faucet calls, per client IP. */
  faucetPerIp: { capacity: 5, windowMs: 60 * 60_000 },
} as const;

/** One faucet grant per address per this many seconds, enforced from the database. */
export const FAUCET_ADDRESS_COOLDOWN_SECONDS = 600;
