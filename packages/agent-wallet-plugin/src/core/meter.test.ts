import { meterDomain, refFromString, usageReceiptTypedData, type CancelMeterRequest, type InstallMeterRequest, type MeterDetail, type MeterListResponse } from "@weir/shared";
import { createPaywall, METER_REASONS, readMeterPayment, readMeterRequirement, type MeterOffer, type PaymentPayload, type PaymentRequirements } from "@weir/x402";
import { getAddress, recoverTypedDataAddress, verifyTypedData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { walletSigner } from "../host.js";
import { ASSET, fakeApi, fakeChain, fakeDeps, fakeHost, fakeIo, MERCHANT, NOW } from "../test/fixtures.js";
import { WeirError } from "./errors.js";
import { summarize } from "./list.js";
import { approvalRequest, openMeter, paidFetch, prepareApproval, prepareMeterStop, readMeterOffer, signApproval, stopMeter } from "./meter.js";
import { renderList } from "./render.js";
import { localSigner } from "./signer.js";

const METER = getAddress("0x75a6385f9BE0dCb12693b0807DB6244B4A947a36");
const FACILITATOR = "https://weir.test";
const API = "https://rates.test/fx?to=PKR";
const TX = `0x${"cd".repeat(32)}` as Hex;
const SUGGESTED = { periodCap: 1_000_000n, period: 86_400, maxTotal: 5_000_000n, termSeconds: 30 * 86_400 };

// The field list the API's strict reader accepts (`parseMeterInstall` in apps/api).
const INSTALL_FIELDS = ["permit", "payer", "terms", "nonce", "deadline", "signature"] satisfies (keyof InstallMeterRequest)[];
const TERMS_FIELDS = ["merchant", "asset", "manager", "periodCap", "period", "maxTotal", "expiresAt", "ref"] satisfies (keyof InstallMeterRequest["terms"])[];

/**
 * A Weir API and a paid API behind its paywall, in one fetch. The facilitator holds one meter for
 * `payer` and checks what matters on the wire: the receipt's signer and that its total is the last
 * plus the price. The relay route records the approval it is sent.
 */
function world(payer: Address, options: { price?: bigint; open?: boolean } = {}) {
  const price = options.price ?? 1_000n;
  const state = { accepted: 0n, approvals: [] as unknown[], handled: 0 };
  const check = async (payload: PaymentPayload, requirement: PaymentRequirements) => {
    const payment = readMeterPayment(payload.payload);
    const asked = readMeterRequirement(requirement);
    if (payment.total !== state.accepted + asked.price) return METER_REASONS.staleTotal;
    const valid = await verifyTypedData({
      address: payer,
      ...usageReceiptTypedData({ domain: meterDomain({ name: "Weir", chainId: asked.chainId, address: asked.meter }), receipt: payment }),
      signature: payment.signature,
    });
    return valid ? undefined : METER_REASONS.badSignature;
  };
  const facilitator = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/v1/relay/meter") {
      state.approvals.push(await request.json());
      return Response.json({ meterId: "7", transactions: { create: TX } });
    }
    if (url.pathname === "/v1/x402/meters") {
      const open = options.open !== false && url.searchParams.get("signer") === payer;
      return Response.json({ meters: open ? [{ id: "7", meter: METER, status: "Active" }] : [] } as unknown as MeterListResponse);
    }
    if (url.pathname === "/v1/x402/meters/7") return Response.json({ id: "7", accepted: state.accepted.toString() });
    const body = (await request.json()) as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
    const reason = await check(body.paymentPayload, body.paymentRequirements);
    if (url.pathname === "/v1/x402/verify") return Response.json(reason === undefined ? { isValid: true, payer } : { isValid: false, invalidReason: reason });
    if (reason !== undefined) return Response.json({ success: false, errorReason: reason, transaction: "", network: "eip155:10143" });
    state.accepted = readMeterPayment(body.paymentPayload.payload).total;
    return Response.json({ success: true, transaction: "", network: "eip155:10143", payer, extra: { total: state.accepted.toString(), meterId: "7" } });
  };
  const network: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith(FACILITATOR)) return facilitator(request);
    return paywall(request, async (paid) => {
      state.handled += 1;
      return Response.json({ to: new URL(paid.url).searchParams.get("to"), rate: 278.5, method: paid.method, body: paid.method === "POST" ? await paid.text() : null });
    });
  };
  const paywall = createPaywall({ chainId: 10143, meter: METER, name: "Weir", version: "1", facilitator: FACILITATOR, payTo: MERCHANT, asset: ASSET, price, suggested: SUGGESTED, description: "Dollar rates", fetch: network });
  return { state, network };
}

describe("reading an offer", () => {
  it("takes the weir-meter offer from a 402", async () => {
    const { network } = world(privateKeyToAccount(generatePrivateKey()).address);
    const { offer, description } = await readMeterOffer(network, API);
    expect(offer).toMatchObject({ chainId: 10143, meter: METER, payTo: MERCHANT, asset: ASSET, price: 1_000n, facilitator: FACILITATOR, suggested: SUGGESTED } satisfies Partial<MeterOffer>);
    expect(description).toBe("Dollar rates");
  });

  it("says why there is no offer: not a 402, or unreachable", async () => {
    const free: typeof fetch = async () => Response.json({ ok: true });
    await expect(readMeterOffer(free, API)).rejects.toMatchObject({ code: "NO_OFFER" });
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(readMeterOffer(down, API)).rejects.toMatchObject({ code: "API_UNREACHABLE" });
    const other: typeof fetch = async () => Response.json({ x402Version: 2, resource: { url: API }, accepts: [{ scheme: "exact", network: "eip155:10143" }] }, { status: 402 });
    await expect(readMeterOffer(other, API)).rejects.toMatchObject({ code: "NO_OFFER" });
  });
});

describe("approving an API", () => {
  const payer = privateKeyToAccount(generatePrivateKey());

  it("takes the API's suggested caps, adds them to the meter's allowance, and names the host", async () => {
    const { network } = world(payer.address);
    const chain = fakeChain(10143, { allowance: 2_000_000n, permitNonce: 4n });
    const plan = await prepareApproval(fakeDeps({ chain }), network, { url: API }, payer.address);
    expect(plan.terms).toMatchObject({ merchant: MERCHANT, asset: ASSET, manager: payer.address, periodCap: 1_000_000n, period: 86_400, maxTotal: 5_000_000n, expiresAt: BigInt(NOW + 30 * 86_400) });
    expect(new TextDecoder().decode(Buffer.from(plan.terms.ref.slice(2), "hex")).replace(/\0+$/, "")).toBe("rates.test");
    expect(plan.permit.value).toBe(7_000_000n);
    expect(plan.permit.request.typedData.message).toMatchObject({ owner: payer.address, spender: METER, value: 7_000_000n, nonce: 4n });
    expect(plan.authorization.request.typedData.domain).toMatchObject({ name: "Weir", chainId: 10143, verifyingContract: METER });
    expect(plan.authorization.request.summary).toBe("Approve rates.test for $0.001 a request, at most $1.00 a day and $5.00 in all, for 30 days");
  });

  it("takes the caller's caps and manager over the suggestion, and refuses caps that cannot work", async () => {
    const { network } = world(payer.address);
    const manager = getAddress("0x00000000000000000000000000000000000000e1");
    const plan = await prepareApproval(fakeDeps(), network, { url: API, perDay: 50_000n, total: 200_000n, days: 7, manager }, payer.address);
    expect(plan.terms).toMatchObject({ manager, periodCap: 50_000n, maxTotal: 200_000n, expiresAt: BigInt(NOW + 7 * 86_400) });
    await expect(prepareApproval(fakeDeps(), network, { url: API, perDay: 999n }, payer.address)).rejects.toThrow(/cover one request/);
    await expect(prepareApproval(fakeDeps(), network, { url: API, perDay: 10_000n, total: 9_999n }, payer.address)).rejects.toThrow(/at least --per-day/);
    await expect(prepareApproval(fakeDeps(), network, { url: API, days: 400 }, payer.address)).rejects.toThrow(/1 to 365/);
  });

  it("signs both payloads as the payer and relays exactly the fields the API reads", async () => {
    const { network, state } = world(payer.address);
    const plan = await prepareApproval(fakeDeps(), network, { url: API }, payer.address);
    const request = await signApproval(plan, localSigner(payer));
    expect(Object.keys(request).sort()).toEqual([...INSTALL_FIELDS].sort());
    expect(Object.keys(request.terms).sort()).toEqual([...TERMS_FIELDS].sort());
    expect(request.terms).toMatchObject({ periodCap: "1000000", maxTotal: "5000000", period: 86_400 });
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(await recoverTypedDataAddress({ ...plan.authorization.request.typedData, signature: request.signature } as Parameters<typeof recoverTypedDataAddress>[0])).toBe(payer.address);
    expect(await recoverTypedDataAddress({ ...plan.permit.request.typedData, signature: request.permit?.signature ?? "0x" } as Parameters<typeof recoverTypedDataAddress>[0])).toBe(payer.address);
    expect(approvalRequest(plan, request.permit?.signature ?? "0x", request.signature)).toEqual(request);

    const opened = await openMeter(network, plan, request);
    expect(opened).toEqual({ meterId: "7", transactions: { create: TX } });
    expect(state.approvals).toEqual([request]);
  });

  it("reports the API's refusal of an approval", async () => {
    const { network } = world(payer.address);
    const plan = await prepareApproval(fakeDeps(), network, { url: API }, payer.address);
    const request = await signApproval(plan, localSigner(payer));
    const refusing: typeof fetch = async () => Response.json({ error: { message: "the permit has expired" } }, { status: 400 });
    await expect(openMeter(refusing, plan, request)).rejects.toMatchObject({ code: "API_REFUSED", message: expect.stringContaining("the permit has expired") });
  });
});

describe("paying requests", () => {
  const payer = privateKeyToAccount(generatePrivateKey());

  it("pays each request with the next running total, and returns the API's answer", async () => {
    const { network, state } = world(payer.address);
    const signer = localSigner(payer);
    const first = await paidFetch(network, signer, API, { maxPrice: 10_000n });
    expect(first).toMatchObject({ status: 200, price: 1_000n, total: 1_000n, meterId: "7" });
    expect(JSON.parse(first.body)).toMatchObject({ to: "PKR", rate: 278.5 });
    const second = await paidFetch(network, signer, API, { maxPrice: 10_000n, method: "POST", body: '{"amount":5}' });
    expect(second).toMatchObject({ total: 2_000n });
    expect(JSON.parse(second.body)).toMatchObject({ method: "POST", body: '{"amount":5}' });
    expect(state).toMatchObject({ accepted: 2_000n, handled: 2 });
  });

  it("signs receipts through the Agent Wallet host, which records what each one pays", async () => {
    const { network, state } = world(payer.address);
    const host = fakeHost(payer);
    const result = await paidFetch(network, walletSigner(host, fakeIo, "weir:fetch", 10143, payer.address), API, { maxPrice: 10_000n });
    expect(result.total).toBe(1_000n);
    expect(state.accepted).toBe(1_000n);
    expect(host.jobs).toHaveLength(1);
    expect(host.jobs[0]).toMatchObject({
      kind: "typed-data",
      chainId: 10143,
      intent: { summary: "Pay for one request to rates.test: the running total on meter 7 becomes $0.001" },
      typedData: { primaryType: "UsageReceipt", message: { meterId: 7n, total: 1_000n } },
    });
  });

  it("refuses a price above the limit, a payee with no meter, and a refused payment, each by name", async () => {
    const pricey = world(payer.address, { price: 20_000n });
    await expect(paidFetch(pricey.network, localSigner(payer), API, { maxPrice: 10_000n })).rejects.toMatchObject({ code: "PRICE_TOO_HIGH" });
    expect(pricey.state.handled).toBe(0);

    const none = world(payer.address, { open: false });
    await expect(paidFetch(none.network, localSigner(payer), API, { maxPrice: 10_000n })).rejects.toMatchObject({ code: "NO_METER", hint: expect.stringContaining("mm weir approve") });

    // The facilitator lists the meter, but the receipt is signed by a key that may not sign for it.
    const stranger = world(payer.address);
    const intruder = { ...localSigner(privateKeyToAccount(generatePrivateKey())), address: payer.address };
    const refused = await paidFetch(stranger.network, intruder, API, { maxPrice: 10_000n }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WeirError);
    expect(refused).toMatchObject({ code: "PAYMENT_REFUSED", message: expect.stringContaining(METER_REASONS.badSignature) });
    expect(stranger.state.handled).toBe(0);
  });

  it("does not pay an API that does not ask", async () => {
    const free: typeof fetch = async () => new Response("free", { headers: { "content-type": "text/plain" } });
    expect(await paidFetch(free, localSigner(payer), API, { maxPrice: 10_000n })).toEqual({ url: API, status: 200, contentType: "text/plain", body: "free" });
  });
});

function meterView(overrides: Partial<MeterDetail> = {}): MeterDetail {
  return {
    id: "7",
    meter: METER,
    chainId: 10143,
    payer: "0x4e80fA4AD069245b976ad4FD4Ff1d8f94965aF8C",
    merchant: MERCHANT,
    asset: ASSET,
    assetSymbol: "tAUSD",
    manager: "0x37Ccf5613cFAD47ddC07C3A86Dc5f29865423176",
    periodCap: "1000000",
    period: 86_400,
    maxTotal: "5000000",
    expiresAt: NOW + 30 * 86_400,
    ref: refFromString("rates.test"),
    status: "Active",
    closedAt: 0,
    totalCharged: "8000",
    accepted: "11000",
    periodUsed: "11000",
    periodStart: NOW - 100,
    calls: 11,
    lastCallAt: NOW - 5,
    createdAt: NOW - 1_000,
    createdTransaction: TX,
    recentCalls: [],
    settlements: [],
    ...overrides,
  } as MeterDetail;
}

// The field list the API's strict reader accepts (`parseMeterCancel` in apps/api).
const CANCEL_FIELDS = ["meterId", "signer", "nonce", "deadline", "signature"] satisfies (keyof CancelMeterRequest)[];

describe("stopping a meter", () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const manager = privateKeyToAccount(generatePrivateKey());

  it("signs a MeterCancel as the payer or the manager and relays exactly the fields the API reads", async () => {
    for (const [account, role] of [
      [payer, "payer"],
      [manager, "manager"],
    ] as const) {
      const api = fakeApi({ meters: [meterView({ payer: payer.address, manager: manager.address })] });
      const deps = fakeDeps({ api });
      const plan = await prepareMeterStop(deps, 7n, account.address);
      expect(plan).toMatchObject({ role, title: "rates.test", chainId: 10143 });
      expect(plan.request.typedData).toMatchObject({ primaryType: "MeterCancel", domain: { name: "Weir", chainId: 10143, verifyingContract: METER }, message: { meterId: 7n } });
      const transaction = await stopMeter(deps, plan, localSigner(account));
      expect(transaction).toMatch(/^0x[0-9a-f]{64}$/);
      const [sent] = api.calls.meterCancel as CancelMeterRequest[];
      expect(Object.keys(sent ?? {}).sort()).toEqual([...CANCEL_FIELDS].sort());
      expect(sent).toMatchObject({ meterId: "7", signer: account.address, deadline: NOW + 15 * 60 });
      expect(await recoverTypedDataAddress({ ...plan.request.typedData, signature: sent?.signature ?? "0x" } as Parameters<typeof recoverTypedDataAddress>[0])).toBe(account.address);
    }
  });

  it("refuses a meter that is not this wallet's, one already stopped, and one that does not exist", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const deps = fakeDeps({ api: fakeApi({ meters: [meterView({ payer: payer.address }), meterView({ id: "8", payer: payer.address, status: "Cancelled", closedAt: NOW - 1 })] }) });
    await expect(prepareMeterStop(deps, 7n, stranger.address)).rejects.toMatchObject({ code: "NOT_YOURS" });
    await expect(prepareMeterStop(deps, 8n, payer.address)).rejects.toMatchObject({ code: "ALREADY_STOPPED" });
    await expect(prepareMeterStop(deps, 9n, payer.address)).rejects.toMatchObject({ code: "METER_NOT_FOUND" });
    const plan = await prepareMeterStop(deps, 7n, payer.address);
    await expect(stopMeter(deps, plan, localSigner(stranger))).rejects.toMatchObject({ code: "SIGNING_FAILED" });
  });
});

describe("listing meters", () => {
  it("shows each meter by the API it pays, with what it has used and settled", () => {
    const report = summarize(MERCHANT, [], NOW, 10143, "UTC", [meterView(), meterView({ id: "8", status: "Cancelled", closedAt: NOW - 1, ref: `0x${"00".repeat(32)}` })]);
    expect(report.meters.map((meter) => [meter.id, meter.title, meter.status])).toEqual([
      ["7", "rates.test", "Active"],
      ["8", `the API paying ${MERCHANT.slice(0, 6)}…${MERCHANT.slice(-4)}`, "Stopped"],
    ]);
    expect(report.meters[0]?.words).toBe("11 requests, $0.011 of $5.00 used ($0.008 settled), at most $1.00 a day");
    const text = renderList(report);
    expect(text).toContain("No mandates paid by");
    expect(text).toContain("meter #7    rates.test [Active], pays");
    expect(text).toContain("11 requests, $0.011 of $5.00 used ($0.008 settled), at most $1.00 a day.");
  });
});
