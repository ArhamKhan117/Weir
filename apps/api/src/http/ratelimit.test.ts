import { describe, expect, it } from "vitest";

import { RateLimiter } from "./ratelimit.js";

describe("the rate limiter", () => {
  it("allows a burst of its capacity, then refuses with the wait until the next token", () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 3, windowMs: 60_000, now: () => now });
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")].every((d) => d.ok)).toBe(true);
    // One token refills every 20 seconds.
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 20 });
    now = 15_000;
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 5 });
    now = 20_000;
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
  });

  it("keeps keys apart", () => {
    const limiter = new RateLimiter({ capacity: 1, windowMs: 1_000, now: () => 0 });
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
    expect(limiter.take("b").ok).toBe(true);
  });

  it("refills to capacity and no further", () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, windowMs: 1_000, now: () => now });
    limiter.take("a");
    now = 1_000_000;
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
  });

  it("refuses a limit that could never allow anything", () => {
    expect(() => new RateLimiter({ capacity: 0, windowMs: 1 })).toThrow(RangeError);
  });
});
