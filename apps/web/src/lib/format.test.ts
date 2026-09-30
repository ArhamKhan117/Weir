import { describe, expect, it } from "vitest";

import { fromNow, periodPhrase, pricePhrase, priceShort, shortAddress } from "./format";

describe("periodPhrase", () => {
  it("names a period in its largest whole unit", () => {
    expect(periodPhrase(2_592_000)).toBe("month");
    expect(periodPhrase(604_800)).toBe("week");
    expect(periodPhrase(1_209_600)).toBe("2 weeks");
    expect(periodPhrase(31_536_000)).toBe("year");
    expect(periodPhrase(90)).toBe("90 seconds");
  });
});

describe("pricePhrase", () => {
  it("reads a periodic plan as an amount every period", () => {
    expect(pricePhrase({ mode: "periodic", amount: "9990000", period: 2_592_000 })).toBe("$9.99 every month");
  });

  it("reads a stream by the hour when that is at least a cent", () => {
    expect(pricePhrase({ mode: "streaming", amount: "100", period: 0 })).toBe("$0.36 an hour, billed by the second");
  });

  it("falls back to the per-second rate for tiny streams", () => {
    expect(pricePhrase({ mode: "streaming", amount: "1", period: 0 })).toBe("$0.000001 a second");
  });

  it("has a short form for buttons", () => {
    expect(priceShort({ mode: "periodic", amount: "5000000", period: 604_800 })).toBe("$5.00 / week");
    expect(priceShort({ mode: "streaming", amount: "100", period: 0 })).toBe("$0.36 / hour");
  });
});

describe("fromNow", () => {
  it("rounds to the largest unit", () => {
    expect(fromNow(1_000 + 3 * 86_400, 1_000)).toBe("in 3 days");
    expect(fromNow(1_000 + 2 * 3_600, 1_000)).toBe("in 2 hours");
    expect(fromNow(1_000 + 30, 1_000)).toBe("now");
  });
});

describe("shortAddress", () => {
  it("keeps the first six and last four characters", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });
});
