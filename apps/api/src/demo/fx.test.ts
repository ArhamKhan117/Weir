import { decodePaymentRequiredHeader, readMeterRequirement, X402_HEADERS } from "@weir/x402";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { createDemo } from "./fx.js";

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
