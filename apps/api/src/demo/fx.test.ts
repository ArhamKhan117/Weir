import { decodePaymentRequiredHeader, readMeterRequirement, X402_HEADERS } from "@weir/x402";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { ApiHttpError } from "../http/errors.js";
import { createDemo, createDemoGate } from "./fx.js";

const METER = getAddress("0x00000000000000000000000000000000000000a1");
const ASSET = getAddress("0x00000000000000000000000000000000000000b1");
const PAY_TO = getAddress("0x00000000000000000000000000000000000000c1");

describe("the paid demo", () => {
  const demo = createDemo({
    chainId: 10143,
    meter: METER,
    name: "Weir",
    version: "1",
    facilitator: "https://api.weir.test",
    payTo: PAY_TO,
    asset: ASSET,
    price: 1_000n,
    suggested: { periodCap: 1_000_000n, period: 86_400, maxTotal: 5_000_000n, termSeconds: 30 * 86_400 },
    fetch: async () => {
      throw new Error("an unpaid request never reaches the facilitator");
    },
    rates: async () => ({ PKR: 278.5 }),
  });

  it("offers weir-meter for the public https address, though the host hands it plain http", async () => {
    // Behind the host's proxy the request arrives as http, on an internal address.
    const response = await demo.request("http://10.0.0.7:8080/fx?to=PKR");
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get(X402_HEADERS.paymentRequired) ?? "");
    expect(required.resource).toMatchObject({ url: "https://api.weir.test/fx?to=PKR", mimeType: "application/json" });
    const [requirement] = required.accepts;
    expect(readMeterRequirement(requirement!)).toMatchObject({ chainId: 10143, meter: METER, payTo: PAY_TO, asset: ASSET, price: 1_000n, facilitator: "https://api.weir.test" });
  });
});

describe("the demo's limits", () => {
  const someone = getAddress("0x00000000000000000000000000000000000000d1");
  const elsewhere = "Try it free on Testnet.";
  const gate = (state: { people: number; known: boolean; balance: bigint }) =>
    createDemoGate({ payTo: PAY_TO, maxPayers: 100, gasReserve: 500n, payers: async () => state, relayerBalance: async () => state.balance, elsewhere });
  const refusal = (promise: Promise<void>) => promise.then(() => undefined, (error: unknown) => (error instanceof ApiHttpError ? [error.status, error.code, error.message] : error));

  it("lets anyone in while there is room and gas", async () => {
    await expect(gate({ people: 99, known: false, balance: 500n })({ payer: someone, merchant: PAY_TO })).resolves.toBeUndefined();
  });

  it("refuses a new person once the demo is full, but not one of the people already counted", async () => {
    expect(await refusal(gate({ people: 100, known: false, balance: 10_000n })({ payer: someone, merchant: PAY_TO }))).toEqual([
      403,
      "limit_reached",
      "The demo was for the first 100 people, and they have tried it. Try it free on Testnet.",
    ]);
    await expect(gate({ people: 100, known: true, balance: 10_000n })({ payer: someone, merchant: PAY_TO })).resolves.toBeUndefined();
  });

  it("pauses while the relayer holds less than its reserve", async () => {
    expect(await refusal(gate({ people: 1, known: true, balance: 499n })({ payer: someone, merchant: PAY_TO }))).toEqual([
      403,
      "limit_reached",
      "The demo is paused for now. Try it free on Testnet.",
    ]);
  });

  it("never limits a meter paying anyone else", async () => {
    await expect(gate({ people: 1_000, known: false, balance: 0n })({ payer: someone, merchant: getAddress("0x00000000000000000000000000000000000000e1") })).resolves.toBeUndefined();
  });
});
