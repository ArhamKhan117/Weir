import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { usageReceiptTypedData, type MeterDetail, type MeterListResponse } from "@weir/shared";
import { getAddress, verifyTypedData, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  createMeterFetch,
  createPaywall,
  METER_REASONS,
  meterRequirement,
  NoMeterError,
  PriceTooHighError,
  readMeterPayment,
  readMeterRequirement,
  X402_HEADERS,
  X402SchemeError,
  type MeterOffer,
} from "./index.js";

const METER = getAddress("0x00000000000000000000000000000000000000a1");
const ASSET = getAddress("0x00000000000000000000000000000000000000b1");
const PAY_TO = getAddress("0x00000000000000000000000000000000000000c1");
const FACILITATOR = "https://facilitator.test";
const NOW = 1_800_000_000;

const offer: MeterOffer = {
  chainId: 10143,
  asset: ASSET,
  payTo: PAY_TO,
  price: 1_000n,
  maxTimeoutSeconds: 60,
  meter: METER,
  name: "Weir",
  version: "1",
  facilitator: FACILITATOR,
  suggested: { periodCap: 5_000_000n, period: 86_400, maxTotal: 20_000_000n, termSeconds: 2_592_000 },
};

/**
 * A facilitator with one meter, checking what the real one checks that matters on the wire: the
 * receipt's signer, and that its total is exactly the last accepted plus the price.
 */
function fakeFacilitator(signer: Address) {
  const state = { accepted: 0n, settled: 0, verifies: 0, meterId: 7n, open: true };
  const check = async (payload: PaymentPayload, requirement: PaymentRequirements): Promise<string | undefined> => {
    const payment = readMeterPayment(payload.payload);
    const asked = readMeterRequirement(requirement);
    if (payment.meterId !== state.meterId) return METER_REASONS.unknownMeter;
    if (payment.total !== state.accepted + asked.price) return METER_REASONS.staleTotal;
    const valid = await verifyTypedData({
      address: signer,
      ...usageReceiptTypedData({
        domain: { name: "Weir", version: "1", chainId: asked.chainId, verifyingContract: asked.meter },
        receipt: { meterId: payment.meterId, total: payment.total, issuedAt: payment.issuedAt },
      }),
      signature: payment.signature,
    });
    return valid ? undefined : METER_REASONS.badSignature;
  };
  const handle = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.origin !== FACILITATOR) return undefined;
    if (url.pathname === "/v1/x402/meters") {
      const body: MeterListResponse = {
        meters: state.open && url.searchParams.get("signer") === signer ? [{ id: state.meterId.toString(), meter: METER, status: "Active" } as MeterListResponse["meters"][number]] : [],
      };
      return Response.json(body);
    }
    if (url.pathname === `/v1/x402/meters/${state.meterId}`) {
      return Response.json({ id: state.meterId.toString(), accepted: state.accepted.toString() } as Partial<MeterDetail>);
    }
    const body = (await request.json()) as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
    if (url.pathname === "/v1/x402/verify") {
      state.verifies += 1;
      const reason = await check(body.paymentPayload, body.paymentRequirements);
      const response: VerifyResponse = reason === undefined ? { isValid: true, payer: signer } : { isValid: false, invalidReason: reason };
      return Response.json(response);
    }
    if (url.pathname === "/v1/x402/settle") {
      const reason = await check(body.paymentPayload, body.paymentRequirements);
      if (reason !== undefined) return Response.json({ success: false, errorReason: reason, transaction: "", network: "eip155:10143" } satisfies SettleResponse);
      state.accepted = BigInt(readMeterPayment(body.paymentPayload.payload).total);
      state.settled += 1;
      return Response.json({ success: true, transaction: "", network: "eip155:10143", payer: signer, extra: { total: state.accepted.toString() } } satisfies SettleResponse);
    }
    return new Response("not found", { status: 404 });
  };
  return { state, handle };
}

/** One fetch for the whole test world: the facilitator, and an API at api.test behind the paywall. */
function world(
  signer: Address,
  handler: (request: Request) => Response | Promise<Response> = () => Response.json({ rate: 278.5 }),
  price: bigint | ((request: Request) => bigint) = offer.price,
) {
  const facilitator = fakeFacilitator(signer);
  /** Requests that reached the API, paid or not. */
  const api = { requests: 0 };
  const network: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const fromFacilitator = await facilitator.handle(request);
    if (fromFacilitator !== undefined) return fromFacilitator;
    api.requests += 1;
    return paywall(request, handler);
  };
  const paywall = createPaywall({
    chainId: offer.chainId,
    meter: METER,
    name: "Weir",
    version: "1",
    facilitator: FACILITATOR,
    payTo: PAY_TO,
    asset: ASSET,
    price,
    ...(offer.suggested === undefined ? {} : { suggested: offer.suggested }),
    description: "FX rate",
    fetch: network,
  });
  return { facilitator, network, api };
}

describe("the weir-meter scheme", () => {
  it("round-trips an offer through its requirement", () => {
    expect(readMeterRequirement(meterRequirement(offer))).toEqual(offer);
  });

  it("refuses malformed requirements and payments", () => {
    const requirement = meterRequirement(offer);
    expect(() => readMeterRequirement({ ...requirement, scheme: "exact" })).toThrow(X402SchemeError);
    expect(() => readMeterRequirement({ ...requirement, network: "solana:mainnet" })).toThrow(/eip155/);
    expect(() => readMeterRequirement({ ...requirement, amount: "-1" })).toThrow(/base units/);
    expect(() => readMeterRequirement({ ...requirement, extra: { ...requirement.extra, facilitator: "ftp://x" } })).toThrow(/http/);
    expect(() => readMeterPayment({ meterId: "1", total: "2", issuedAt: 3, signature: "0x123" })).toThrow(/hex/);
    expect(() => readMeterPayment({ meterId: "1", total: "2", issuedAt: -1, signature: "0x12" })).toThrow(/unix/);
  });
});

describe("the paywall's resource", () => {
  it("names the request's URL, or the public one when the host ends TLS", async () => {
    const options = { chainId: 10143, meter: METER, name: "Weir", version: "1", facilitator: FACILITATOR, payTo: PAY_TO, asset: ASSET, price: 1_000n };
    const handler = () => Response.json({});
    const plain = await createPaywall(options)(new Request("http://10.0.0.7/fx?to=PKR"), handler);
    expect(decodePaymentRequiredHeader(plain.headers.get(X402_HEADERS.paymentRequired) ?? "").resource.url).toBe("http://10.0.0.7/fx?to=PKR");
    const proxied = await createPaywall({ ...options, resourceUrl: (request) => request.url.replace("http://10.0.0.7", "https://api.test") })(new Request("http://10.0.0.7/fx?to=PKR"), handler);
    expect(decodePaymentRequiredHeader(proxied.headers.get(X402_HEADERS.paymentRequired) ?? "").resource.url).toBe("https://api.test/fx?to=PKR");
  });
});

describe("the paywall and the paying fetch, together", () => {
  it("answers an unpaid request with a 402 offering weir-meter", async () => {
    const { network } = world(privateKeyToAccount(generatePrivateKey()).address);
    const response = await network("https://api.test/fx?to=PKR");
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get(X402_HEADERS.paymentRequired) ?? "");
    expect(required.x402Version).toBe(2);
    expect(required.resource.url).toBe("https://api.test/fx?to=PKR");
    expect(readMeterRequirement(required.accepts[0] as PaymentRequirements)).toEqual(offer);
  });

  it("pays each request with the next running total, and serves it", async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const { facilitator, network } = world(key.address);
    const paid: bigint[] = [];
    const pay = createMeterFetch({ signer: key, maxPrice: 5_000n, fetch: network, now: () => NOW, onPayment: (event) => paid.push(event.total) });

    for (let i = 0; i < 5; i += 1) {
      const response = await pay("https://api.test/fx?to=PKR");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ rate: 278.5 });
      const settlement = decodePaymentResponseHeader(response.headers.get(X402_HEADERS.paymentResponse) ?? "");
      expect(settlement.success).toBe(true);
    }
    expect(paid).toEqual([1_000n, 2_000n, 3_000n, 4_000n, 5_000n]);
    expect(facilitator.state.accepted).toBe(5_000n);
  });

  it("pays an endpoint it has paid before up front, in one round trip", async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const { facilitator, network, api } = world(key.address);
    const pay = createMeterFetch({ signer: key, maxPrice: 5_000n, fetch: network, now: () => NOW });
    expect((await pay("https://api.test/fx?to=PKR")).status).toBe(200);
    expect(api.requests).toBe(2);
    for (let i = 0; i < 3; i += 1) expect((await pay("https://api.test/fx?to=PKR")).status).toBe(200);
    expect(api.requests).toBe(5);
    // Another endpoint is asked first, once.
    expect((await pay("https://api.test/fx?to=EUR")).status).toBe(200);
    expect(api.requests).toBe(7);
    expect(facilitator.state.accepted).toBe(5_000n);
  });

  it("pays on the new terms when a remembered endpoint changes its price, on the same meter", async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    let price = 1_000n;
    const { facilitator, network } = world(key.address, undefined, () => price);
    const paid: bigint[] = [];
    const pay = createMeterFetch({ signer: key, maxPrice: 5_000n, fetch: network, now: () => NOW, onPayment: (event) => paid.push(event.offer.price) });
    expect((await pay("https://api.test/fx")).status).toBe(200);
    price = 2_000n;
    expect((await pay("https://api.test/fx")).status).toBe(200);
    expect((await pay("https://api.test/fx")).status).toBe(200);
    expect(paid).toEqual([1_000n, 2_000n, 2_000n]);
    expect(facilitator.state.accepted).toBe(5_000n);
    price = 9_000n;
    await expect(pay("https://api.test/fx")).rejects.toBeInstanceOf(PriceTooHighError);
  });

  it("looks for the meter again when the remembered one is refused", async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const { facilitator, network } = world(key.address);
    const pay = createMeterFetch({ signer: key, maxPrice: 5_000n, fetch: network, now: () => NOW });
    expect((await pay("https://api.test/fx")).status).toBe(200);
    // The payer stopped meter 7 and approved the API again: meter 8 pays from here on.
    facilitator.state.meterId = 8n;
    expect((await pay("https://api.test/fx")).status).toBe(200);
    expect(facilitator.state.accepted).toBe(2_000n);
    // Stopped with no other meter: the request says so, as a first request would.
    facilitator.state.meterId = 9n;
    facilitator.state.open = false;
    await expect(pay("https://api.test/fx")).rejects.toBeInstanceOf(NoMeterError);
    expect(facilitator.state.accepted).toBe(2_000n);
  });

  it("signs one receipt at a time on a meter, so parallel requests all pay", async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const { facilitator, network } = world(key.address);
    const pay = createMeterFetch({ signer: key, maxPrice: 5_000n, fetch: network, now: () => NOW });
    const responses = await Promise.all(Array.from({ length: 6 }, () => pay("https://api.test/fx")));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(facilitator.state.accepted).toBe(6_000n);
  });

  it("re-reads the total once when another device moved it", async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const { facilitator, network } = world(key.address);
    const pay = createMeterFetch({ signer: key, maxPrice: 5_000n, fetch: network, now: () => NOW });
    await pay("https://api.test/fx");
    facilitator.state.accepted += 3_000n; // spent elsewhere
    const response = await pay("https://api.test/fx");
    expect(response.status).toBe(200);
    expect(facilitator.state.accepted).toBe(5_000n);
  });

  it("does not charge a request the API failed", async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const { facilitator, network } = world(key.address, () => Response.json({ error: "down" }, { status: 500 }));
    const pay = createMeterFetch({ signer: key, maxPrice: 5_000n, fetch: network, now: () => NOW });
    const response = await pay("https://api.test/fx");
    expect(response.status).toBe(500);
    expect(response.headers.get(X402_HEADERS.paymentResponse)).toBeNull();
    expect(facilitator.state.accepted).toBe(0n);
    expect(facilitator.state.verifies).toBe(1);
  });

  it("refuses to pay above maxPrice, and says when there is no meter", async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const { network } = world(key.address);
    await expect(createMeterFetch({ signer: key, maxPrice: 999n, fetch: network })("https://api.test/fx")).rejects.toBeInstanceOf(PriceTooHighError);

    const stranger = privateKeyToAccount(generatePrivateKey());
    await expect(createMeterFetch({ signer: stranger, maxPrice: 5_000n, fetch: network })("https://api.test/fx")).rejects.toBeInstanceOf(NoMeterError);
  });

  it("refuses a receipt from a key that is not the meter's", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const forger = privateKeyToAccount(generatePrivateKey());
    const { facilitator, network } = world(owner.address);
    const pay = createMeterFetch({ signer: forger, maxPrice: 5_000n, fetch: network, now: () => NOW, meterFor: async () => 7n });
    const response = await pay("https://api.test/fx");
    expect(response.status).toBe(402);
    expect(decodePaymentRequiredHeader(response.headers.get(X402_HEADERS.paymentRequired) ?? "").error).toBe(METER_REASONS.badSignature);
    expect(facilitator.state.accepted).toBe(0n);
  });

  it("refuses a payment made for a different offer", async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const { network } = world(key.address);
    const cheap = createMeterFetch({ signer: key, maxPrice: 5_000n, fetch: network, now: () => NOW });
    // A client that rewrites the price in the offer it echoes back is refused before verification.
    const tampering: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const header = request.headers.get(X402_HEADERS.paymentSignature);
      if (header !== null) {
        const payload = JSON.parse(atob(header)) as PaymentPayload;
        payload.accepted = { ...payload.accepted, amount: "1" };
        request.headers.set(X402_HEADERS.paymentSignature, btoa(JSON.stringify(payload)));
      }
      return network(request);
    };
    const response = await createMeterFetch({ signer: key, maxPrice: 5_000n, fetch: tampering, now: () => NOW })("https://api.test/fx");
    expect(response.status).toBe(402);
    expect(decodePaymentRequiredHeader(response.headers.get(X402_HEADERS.paymentRequired) ?? "").error).toMatch(/not for this offer/);
    expect((await cheap("https://api.test/fx")).status).toBe(200);
  });
});
