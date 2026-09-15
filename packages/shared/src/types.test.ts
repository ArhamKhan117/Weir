import { describe, expect, it } from "vitest";

import { mandateStatusFromIndex, standingOf, type MandateRecord } from "./types.js";

const base: Pick<MandateRecord, "status" | "pausedAt" | "expiresAt" | "totalCharged" | "maxTotal" | "amount" | "period"> =
  {
    status: "Active",
    pausedAt: 0n,
    expiresAt: 2_000n,
    totalCharged: 0n,
    maxTotal: 30n,
    amount: 10n,
    period: 60,
  };

describe("mandateStatusFromIndex", () => {
  it("maps the enum in declaration order", () => {
    expect([0, 1, 2].map(mandateStatusFromIndex)).toEqual(["Active", "Delinquent", "Cancelled"]);
  });

  it("refuses an index the contract cannot return", () => {
    expect(() => mandateStatusFromIndex(3)).toThrow(RangeError);
  });
});

describe("standingOf", () => {
  it("reads a live mandate as active", () => {
    expect(standingOf(base, 1_000n)).toBe("Active");
  });

  it("lets cancellation win over everything", () => {
    expect(standingOf({ ...base, status: "Cancelled", pausedAt: 5n }, 5_000n)).toBe("Cancelled");
  });

  it("derives expiry from the clock, inclusive of the expiry second", () => {
    expect(standingOf(base, 2_000n)).toBe("Active");
    expect(standingOf(base, 2_001n)).toBe("Expired");
  });

  it("calls a periodic mandate complete when one more charge would pass its cap", () => {
    expect(standingOf({ ...base, totalCharged: 20n }, 1_000n)).toBe("Active");
    expect(standingOf({ ...base, totalCharged: 21n }, 1_000n)).toBe("Completed");
  });

  it("calls a stream complete only when its cap is spent", () => {
    const stream = { ...base, period: 0, amount: 100n };
    expect(standingOf({ ...stream, totalCharged: 29n }, 1_000n)).toBe("Active");
    expect(standingOf({ ...stream, totalCharged: 30n }, 1_000n)).toBe("Completed");
  });

  it("shows a paused stream as paused and a delinquent one as past due", () => {
    expect(standingOf({ ...base, period: 0, pausedAt: 900n }, 1_000n)).toBe("Paused");
    expect(standingOf({ ...base, status: "Delinquent" }, 1_000n)).toBe("Past due");
  });
});
