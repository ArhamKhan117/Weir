import { refFromString, type Plan } from "@weir/shared";
import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import { termsFor, toWire } from "./mandate";

const plan: Plan = {
  id: "pln_abcdefghijklmnop",
  merchant: { id: "m", name: "Studio", payoutAddress: "0x00000000000000000000000000000000000000aa" },
  name: "Pro",
  description: "",
  asset: "0x00000000000000000000000000000000000000bb",
  assetSymbol: "tAUSD",
  mode: "periodic",
  amount: "9990000",
  period: 2_592_000,
  trialDays: 0,
  maxPerCharge: "9990000",
  maxTotal: "119880000",
  termSeconds: 31_104_000,
  active: true,
  createdAt: 0,
};

const manager = "0x00000000000000000000000000000000000000cc";

describe("termsFor", () => {
  it("installs exactly the plan's terms, paying the merchant, with the session key as manager", () => {
    const terms = termsFor(plan, { manager, now: 1_000 });
    expect(terms).toEqual({
      merchant: plan.merchant.payoutAddress,
      asset: plan.asset,
      vault: zeroAddress,
      manager,
      amount: 9_990_000n,
      period: 2_592_000,
      startAt: 0n,
      maxPerCharge: 9_990_000n,
      maxTotal: 119_880_000n,
      expiresAt: 1_000n + 31_104_000n,
      ref: refFromString(plan.id),
    });
  });

  it("starts the first charge after a trial", () => {
    expect(termsFor({ ...plan, trialDays: 7 }, { manager, now: 1_000 }).startAt).toBe(1_000n + 7n * 86_400n);
  });

  it("marks a stream with a zero period", () => {
    expect(termsFor({ ...plan, mode: "streaming", period: 0, amount: "100" }, { manager, now: 1_000 }).period).toBe(0);
  });

  it("draws from savings when asked", () => {
    const vault = "0x00000000000000000000000000000000000000dd";
    expect(termsFor(plan, { manager, vault, now: 1_000 }).vault).toBe(vault);
  });

  it("puts amounts on the wire as decimal strings", () => {
    const wire = toWire(termsFor(plan, { manager, now: 1_000 }));
    expect(wire.amount).toBe("9990000");
    expect(wire.maxTotal).toBe("119880000");
    expect(wire.expiresAt).toBe(31_105_000);
  });
});
