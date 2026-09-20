import type { MandateStanding } from "@weir/shared";
import { describe, expect, it } from "vitest";

import { merchantStats, monthlyAmount, THIRTY_DAYS } from "./stats.js";

const mandate = (standing: MandateStanding, amount: string, period: number, assetSymbol = "tAUSD") => ({
  standing,
  amount,
  period,
  assetSymbol,
});

describe("MRR", () => {
  it("scales each active periodic mandate to thirty days", () => {
    expect(monthlyAmount(mandate("Active", "9990000", THIRTY_DAYS))).toBe(9_990_000n);
    expect(monthlyAmount(mandate("Active", "1000000", 604_800))).toBe(4_285_714n); // weekly: 30/7, rounded down
    expect(monthlyAmount(mandate("Active", "1", 86_400))).toBe(30n);
    expect(monthlyAmount(mandate("Active", "5000000", 31_536_000))).toBe(410_958n); // yearly
  });

  it("leaves out streams and anything not active", () => {
    expect(monthlyAmount(mandate("Active", "4", 0))).toBe(0n);
    for (const standing of ["Paused", "Past due", "Cancelled", "Expired", "Completed"] as const) {
      expect(monthlyAmount(mandate(standing, "9990000", THIRTY_DAYS))).toBe(0n);
    }
  });
});

describe("merchant stats", () => {
  it("counts, sums per symbol exactly, and totals what was collected", () => {
    const stats = merchantStats(
      [
        mandate("Active", "9990000", THIRTY_DAYS),
        mandate("Active", "9990000", THIRTY_DAYS),
        mandate("Active", "1000000", 604_800, "USDC"),
        mandate("Active", "4", 0),
        mandate("Past due", "9990000", THIRTY_DAYS),
        mandate("Cancelled", "9990000", THIRTY_DAYS),
      ],
      [
        { assetSymbol: "tAUSD", amount: "19980000" },
        { assetSymbol: "USDC", amount: "123" },
        { assetSymbol: "tAUSD", amount: "20" },
      ],
    );
    expect(stats).toEqual({
      activeMandates: 4,
      pastDue: 1,
      mrr: { USDC: "4285714", tAUSD: "19980000" },
      collected30d: { USDC: "123", tAUSD: "19980020" },
    });
  });

  it("does not lose precision past 2^53", () => {
    const big = (2n ** 90n).toString();
    const stats = merchantStats([mandate("Active", big, THIRTY_DAYS), mandate("Active", big, THIRTY_DAYS)], []);
    expect(stats.mrr.tAUSD).toBe((2n ** 91n).toString());
  });

  it("is empty for a merchant with nothing", () => {
    expect(merchantStats([], [])).toEqual({ activeMandates: 0, pastDue: 0, mrr: {}, collected30d: {} });
  });
});
