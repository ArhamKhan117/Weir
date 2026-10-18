/**
 * Pay-per-request, end to end on a local node: the paid demo API answers 402 with a `weir-meter`
 * offer; a payer with no gas approves it once (a permit and a signed authorization, relayed in one
 * transaction); their session key then pays request after request through the paying fetch, with
 * no transaction each; the facilitator refuses what the caps refuse; the settler settles the
 * running total on chain, the indexer reads it back, the merchant is paid exactly that; the session
 * key stops the meter; and the business's webhooks arrive signed.
 *
 * Runs whenever `anvil` is on the PATH and Postgres answers; skips cleanly otherwise.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { serve, type ServerType } from "@hono/node-server";
import {
  meterAuthorizationTypedData,
  meterCancelTypedData,
  meterDomain,
  permitTypedData,
  randomNonce,
  refFromString,
  stablecoinAbi,
  usageReceiptTypedData,
  type InstallMeterResponse,
  type MerchantOverview,
  type MeterDetail,
  type MeterView,
  type PayerResponse,
  type RelayResponse,
} from "@weir/shared";
import {
  createMeterFetch,
  decodePaymentRequiredHeader,
  meterOffersOf,
  NoMeterError,
  METER_REASONS,
  X402_HEADERS,
  type PaymentRequired,
  type VerifyResponse,
} from "@weir/x402";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { UpdateMerchantResponse } from "./http/app.js";
import { createLogger, silentLogger } from "./log.js";
import { createApiService, type ApiService } from "./service.js";
import { anvilAccount, anvilAvailable, deployWeir, freePort, startAnvil, type AnvilNode, type WeirOnAnvil } from "./test/anvil.js";
import { openTestDatabase, type TestDatabase } from "./test/db.js";
import { verifyWebhookSignature } from "./webhooks/sign.js";

const enabled = anvilAvailable();
const db: TestDatabase | undefined = enabled ? await openTestDatabase("meter") : undefined;

describe.skipIf(!enabled || db === undefined)("pay-per-request on a local node", () => {
  let node: AnvilNode;
  let weir: WeirOnAnvil;
  let service: ApiService;
  let server: ServerType;
  let hookServer: Server;
  let base: string;
  const hooks: { body: string; signature: string | undefined }[] = [];

  const merchant = privateKeyToAccount(generatePrivateKey());
  const payer = privateKeyToAccount(generatePrivateKey());
  const session = privateKeyToAccount(generatePrivateKey());
  const dev = { authorization: `Dev ${merchant.address}` };
  const PRICE = 1_000n;

  const call = async <T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, headers: response.headers, body: (await response.json()) as T };
  };

  async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
    const started = Date.now();
    for (;;) {
      const value = await read().catch(() => undefined as T);
      if (value !== undefined && done(value)) return value;
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const detail = (id: string) => call<MeterDetail>(`/v1/x402/meters/${id}`);

  beforeAll(async () => {
    node = await startAnvil();
    weir = await deployWeir(node);

    hookServer = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        const signature = request.headers["weir-signature"];
        hooks.push({ body, signature: Array.isArray(signature) ? signature[0] : signature });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", resolve));

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    service = createApiService({
      network: { chainId: anvil.id, chain: anvil, rpcUrl: node.rpcUrl, logChunkBlocks: 100, mainnet: false, deployment: weir.deployment },
      sql: db!.sql,
      publicClient: node.publicClient,
      logger: process.env.WEIR_TEST_LOG === "1" ? createLogger("meter-test") : silentLogger,
      relayerAccount: anvilAccount(1),
      devAuth: true,
      faucetAmount: 100_000_000n,
      allowedOrigins: [],
      indexer: true,
      indexerOptions: { pollMs: 100, reorgWindowBlocks: 5 },
      webhookOptions: { pollMs: 100, backoffMs: [200, 200, 200] },
      meters: {
        settleMin: 1n,
        settleAfterSeconds: 10,
        // The test drives the settler itself.
        settlePollMs: 3_600_000,
        publicUrl: base,
        demo: { payTo: merchant.address, price: PRICE, rates: async () => ({ PKR: 278.5, EUR: 0.92 }) },
      },
    });
    service.start();
    server = serve({ fetch: service.app.fetch, port, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
    await service?.stop();
    await new Promise<void>((resolve) => (hookServer === undefined ? resolve() : hookServer.close(() => resolve())));
    await node?.stop();
    await db?.close();
  });

  let meterId: string;
  let webhookSecret: string;

  it("lists weir-meter among the facilitator's supported kinds", async () => {
    const supported = await call<{ kinds: { scheme: string; network: string; extra: { meter: string } }[]; signers: Record<string, string[]> }>(
      "/v1/x402/supported",
    );
    expect(supported.body.kinds).toEqual([
      { x402Version: 2, scheme: "weir-meter", network: `eip155:${anvil.id}`, extra: { meter: weir.meter, name: "Weir", version: "1" } },
    ]);
    expect(supported.body.signers[`eip155:${anvil.id}`]).toEqual([anvilAccount(1).address]);
  });

  it("answers an unpaid request to the demo API with a weir-meter offer", async () => {
    const profile = await call<UpdateMerchantResponse>("/v1/merchant", {
      method: "PUT",
      headers: dev,
      body: { name: "FX API", webhookUrl: `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hooks` },
    });
    expect(profile.status).toBe(200);
    webhookSecret = profile.body.webhookSecret ?? "";

    const response = await fetch(`${base}/demo/fx?to=PKR`);
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get(X402_HEADERS.paymentRequired) ?? "") as PaymentRequired;
    const [offer] = meterOffersOf(required);
    expect(offer?.offer).toMatchObject({
      chainId: anvil.id,
      asset: weir.token,
      payTo: merchant.address,
      price: PRICE,
      meter: weir.meter,
      facilitator: base,
      suggested: { periodCap: 1_000_000n, period: 86_400, maxTotal: 5_000_000n },
    });
  });

  it("opens a meter from a permit and one signature, with no gas from the payer", async () => {
    const granted = await call<{ transaction: string }>("/v1/faucet", { body: { address: payer.address } });
    expect(granted.status).toBe(200);

    const now = Math.floor(Date.now() / 1000);
    const terms = {
      merchant: merchant.address,
      asset: weir.token,
      manager: session.address,
      periodCap: 5_000n,
      period: 3_600,
      maxTotal: 8_000n,
      expiresAt: BigInt(now + 30 * 86_400),
      ref: refFromString("demo-fx"),
    };
    const nonce = randomNonce();
    const signature = await payer.signTypedData(
      meterAuthorizationTypedData({
        domain: meterDomain({ name: "Weir", chainId: anvil.id, address: weir.meter }),
        payer: payer.address,
        terms,
        nonce,
        deadline: BigInt(now + 600),
      }),
    );
    const permitNonce = await node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "nonces", args: [payer.address] });
    const permitSignature = await payer.signTypedData(
      permitTypedData({
        token: { address: weir.token, permit: { name: "Test AUSD", version: "1" } },
        chainId: anvil.id,
        owner: payer.address,
        spender: weir.meter,
        value: terms.maxTotal,
        nonce: permitNonce,
        deadline: BigInt(now + 600),
      }),
    );

    const installed = await call<InstallMeterResponse>("/v1/relay/meter", {
      body: {
        permit: { token: weir.token, owner: payer.address, value: terms.maxTotal.toString(), deadline: now + 600, signature: permitSignature },
        payer: payer.address,
        terms: { ...terms, periodCap: "5000", maxTotal: "8000", expiresAt: Number(terms.expiresAt) },
        nonce: nonce.toString(),
        deadline: now + 600,
        signature,
      },
    });
    expect(installed.status).toBe(200);
    meterId = installed.body.meterId;
    expect(meterId).toBe("1");
    // One transaction carried both the permit and the authorization.
    expect(installed.body.transactions.permit).toBe(installed.body.transactions.create);

    const indexed = await until(() => detail(meterId), (r) => r.status === 200, "the meter to be indexed");
    expect(indexed.body).toMatchObject({ payer: payer.address, merchant: merchant.address, manager: session.address, status: "Active", accepted: "0" });
    const allowance = await node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "allowance", args: [payer.address, weir.meter] });
    expect(allowance).toBe(8_000n);
  });

  it("pays request after request from the session key, with no transaction each", async () => {
    const pay = createMeterFetch({ signer: session, maxPrice: 2_000n });
    for (let i = 0; i < 5; i += 1) {
      const response = await pay(`${base}/demo/fx?to=PKR`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ base: "USD", to: "PKR", rate: 278.5 });
    }
    const after = await detail(meterId);
    expect(after.body).toMatchObject({ accepted: "5000", calls: 5, periodUsed: "5000", totalCharged: "0" });
    expect(after.body.recentCalls.map((c) => c.total)).toEqual(["5000", "4000", "3000", "2000", "1000"]);
    expect(after.body.recentCalls[0]?.resource).toBe(`${base}/demo/fx?to=PKR`);
  });

  it("refuses a request past the period cap, and a receipt from any other key", async () => {
    const pay = createMeterFetch({ signer: session, maxPrice: 2_000n });
    const refused = await pay(`${base}/demo/fx?to=PKR`);
    expect(refused.status).toBe(402);
    expect(decodePaymentRequiredHeader(refused.headers.get(X402_HEADERS.paymentRequired) ?? "").error).toBe(METER_REASONS.periodCap);

    // A stranger's receipt for the right next total is refused by the facilitator.
    const stranger = privateKeyToAccount(generatePrivateKey());
    const offer = await fetch(`${base}/demo/fx?to=EUR`).then((r) => decodePaymentRequiredHeader(r.headers.get(X402_HEADERS.paymentRequired) ?? ""));
    const requirement = offer.accepts[0]!;
    const issuedAt = BigInt(Math.floor(Date.now() / 1000));
    const forged = await stranger.signTypedData(
      usageReceiptTypedData({ domain: meterDomain({ name: "Weir", chainId: anvil.id, address: weir.meter }), receipt: { meterId: 1n, total: 6_000n, issuedAt } }),
    );
    const verdict = await call<VerifyResponse>("/v1/x402/verify", {
      body: {
        x402Version: 2,
        paymentPayload: { x402Version: 2, accepted: requirement, payload: { meterId: "1", total: "6000", issuedAt: Number(issuedAt), signature: forged } },
        paymentRequirements: requirement,
      },
    });
    expect(verdict.body).toMatchObject({ isValid: false, invalidReason: METER_REASONS.badSignature });
  });

  it("settles the running total on chain, and the merchant is paid exactly that", async () => {
    expect(await service.settler!.tick()).toBe(1);
    const settled = await until(() => detail(meterId), (r) => r.body.totalCharged === "5000", "the settlement to be indexed");
    expect(settled.body.settlements).toHaveLength(1);
    expect(settled.body.settlements[0]).toMatchObject({ kind: "settled", amount: "5000", receiptTotal: "5000" });
    const balance = await node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "balanceOf", args: [merchant.address] });
    expect(balance).toBe(5_000n);
    // Nothing more is owed, so nothing more is sent.
    expect(await service.settler!.tick()).toBe(0);
  });

  it("lets the session key stop the meter, after which nothing more is accepted", async () => {
    const now = Math.floor(Date.now() / 1000);
    const nonce = randomNonce();
    const signature = await session.signTypedData(
      meterCancelTypedData({ domain: meterDomain({ name: "Weir", chainId: anvil.id, address: weir.meter }), meterId: 1n, nonce, deadline: BigInt(now + 600) }),
    );
    const stopped = await call<RelayResponse>("/v1/relay/meter/cancel", {
      body: { meterId, signer: session.address, nonce: nonce.toString(), deadline: now + 600, signature },
    });
    expect(stopped.status).toBe(200);
    await until(() => detail(meterId), (r) => r.body.status === "Cancelled", "the stop to be indexed");

    const pay = createMeterFetch({ signer: session, maxPrice: 2_000n });
    await expect(pay(`${base}/demo/fx?to=PKR`)).rejects.toBeInstanceOf(NoMeterError);
  });

  it("shows the meter to the payer and to the business", async () => {
    const payerView = await call<PayerResponse>(`/v1/payers/${payer.address}`);
    expect(payerView.body.meters.map((m: MeterView) => [m.id, m.status, m.totalCharged])).toEqual([["1", "Cancelled", "5000"]]);
    const overview = await call<MerchantOverview>("/v1/merchant/overview", { headers: dev });
    expect(overview.body.meters.map((m: MeterView) => [m.id, m.payer, m.calls])).toEqual([["1", payer.address, 5]]);
  });

  it("tells the business by signed webhook: opened, settled, stopped", async () => {
    await until(async () => hooks.length, (n) => n >= 3, "three webhooks");
    const events = hooks.map((hook) => {
      expect(verifyWebhookSignature(webhookSecret, hook.body, hook.signature, Math.floor(Date.now() / 1000))).toBe(true);
      return JSON.parse(hook.body) as { type: string; data: { meter: MeterView; event: Record<string, string> } };
    });
    expect(events.map((event) => event.type)).toEqual(["meter.created", "meter.settled", "meter.cancelled"]);
    expect(events[1]?.data.event).toMatchObject({ amount: "5000", totalCharged: "5000", receiptTotal: "5000" });
  }, 30_000);
});
