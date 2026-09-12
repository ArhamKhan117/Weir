import { describe, expect, it } from "vitest";

import { formatDollars, formatDollarsExact, parseDollars, rateOver, ratePerSecond } from "./money.js";

describe("parseDollars", () => {
  it("parses exactly, with or without a sign, commas and trailing digits", () => {
    expect(parseDollars("$12.50")).toBe(12_500_000n);
    expect(parseDollars("1,000")).toBe(1_000_000_000n);
    expect(parseDollars("0.000278")).toBe(278n);
    expect(parseDollars("7.")).toBe(7_000_000n);
  });

  it("refuses more than six decimals and anything that is not an amount", () => {
    expect(() => parseDollars("0.0000001")).toThrow(RangeError);
    expect(() => parseDollars("-1")).toThrow(RangeError);
    expect(() => parseDollars("ten")).toThrow(RangeError);
  });
});

describe("formatDollars", () => {
  it("rounds to the cent, half up, with grouping", () => {
    expect(formatDollars(1_234_565_000n)).toBe("$1,234.57");
    expect(formatDollars(4_999n)).toBe("$0.00");
    expect(formatDollars(5_000n)).toBe("$0.01");
  });

  it("keeps sub-cent precision in the exact form", () => {
    expect(formatDollarsExact(278n)).toBe("$0.000278");
    expect(formatDollarsExact(4_200_000n)).toBe("$4.20");
  });
});

describe("rates", () => {
  it("converts between a per-second rate and longer spans", () => {
    expect(ratePerSecond(parseDollars("0.36"), "hour")).toBe(100n);
    expect(rateOver(100n, "hour")).toBe(360_000n);
    expect(rateOver(100n, "month")).toBe(259_200_000n);
  });
});
