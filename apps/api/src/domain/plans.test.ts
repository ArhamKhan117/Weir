import { refFromString } from "@weir/shared";
import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { ApiHttpError } from "../http/errors.js";
import { newMerchantId, newPlanId, PLAN_ID_PATTERN } from "./ids.js";
import { validatePlan } from "./plans.js";

const tAUSD = getAddress("0x00000000000000000000000000000000000000b1");
const symbolFor = (asset: Address): string | undefined => (asset === tAUSD ? "tAUSD" : undefined);

const periodic = {
  name: "  Pro monthly  ",
  description: "Everything",
  asset: tAUSD,
  mode: "periodic",
  amount: "9990000",
  period: 2_592_000,
  trialDays: 0,
  maxPerCharge: "9990000",
  maxTotal: "119880000",
  termSeconds: 31_536_000,
};

const streaming = { ...periodic, mode: "streaming", amount: "4", period: 0, maxPerCharge: "1000000", maxTotal: "10000000" };

function refused(body: unknown, pattern: RegExp): void {
  let caught: unknown;
  try {
    validatePlan(body, symbolFor);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiHttpError);
  expect((caught as ApiHttpError).status).toBe(400);
  expect((caught as ApiHttpError).message).toMatch(pattern);
}

describe("plan validation", () => {
  it("accepts a periodic plan the hub would accept, trimmed and typed", () => {
    const plan = validatePlan(periodic, symbolFor);
    expect(plan).toMatchObject({ name: "Pro monthly", assetSymbol: "tAUSD", amount: 9_990_000n, maxTotal: 119_880_000n });
  });

  it("accepts a streaming plan with period zero", () => {
    expect(validatePlan(streaming, symbolFor)).toMatchObject({ mode: "streaming", period: 0, amount: 4n });
  });

  it("holds the period to the hub's range", () => {
    refused({ ...periodic, period: 59 }, /period must be between 60 and 31536000/);
    refused({ ...periodic, period: 31_536_001 }, /period must be between/);
    expect(validatePlan({ ...periodic, period: 60 }, symbolFor).period).toBe(60);
    expect(validatePlan({ ...periodic, period: 31_536_000 }, symbolFor).period).toBe(31_536_000);
    refused({ ...streaming, period: 60 }, /period must be 0 for a streaming plan/);
  });

  it("holds the caps to what one charge needs", () => {
    refused({ ...periodic, maxPerCharge: "9989999" }, /maxPerCharge must be at least amount/);
    refused({ ...periodic, maxTotal: "9989999" }, /maxTotal must be at least amount/);
    refused({ ...streaming, maxTotal: "3" }, /maxTotal must be at least amount/);
    refused({ ...periodic, amount: "0" }, /amount must be at least 1/);
    refused({ ...periodic, maxTotal: (2n ** 96n).toString() }, /maxTotal must be at most/);
  });

  it("wants an accepted asset", () => {
    refused({ ...periodic, asset: getAddress("0x00000000000000000000000000000000000000c1") }, /is not one the hub accepts/);
  });

  it("wants the term to reach the first charge", () => {
    expect(validatePlan({ ...periodic, trialDays: 7, termSeconds: 7 * 86_400 }, symbolFor).trialDays).toBe(7);
    refused({ ...periodic, trialDays: 7, termSeconds: 7 * 86_400 - 1 }, /termSeconds must reach the first charge/);
    refused({ ...streaming, trialDays: 1, termSeconds: 86_400 }, /termSeconds must run past the end of the trial/);
  });

  it("refuses missing, malformed and unexpected fields", () => {
    const { name: _name, ...nameless } = periodic;
    void _name;
    refused(nameless, /name is required/);
    refused({ ...periodic, name: "   " }, /name must not be empty/);
    refused({ ...periodic, mode: "yearly" }, /mode must be one of periodic, streaming/);
    refused({ ...periodic, amount: 9_990_000 }, /amount must be a decimal string/);
    refused({ ...periodic, currency: "USD" }, /unexpected field currency/);
  });
});

describe("plan ids", () => {
  it("are pln_ and 16 base32 characters, and fit a ref", () => {
    const ids = new Set(Array.from({ length: 200 }, newPlanId));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(PLAN_ID_PATTERN);
      expect(() => refFromString(id)).not.toThrow();
    }
    expect(newMerchantId()).toMatch(/^mer_[a-z2-7]{16}$/);
  });
});
