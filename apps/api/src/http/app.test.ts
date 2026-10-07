import {
  pushSubscriptionTypedData,
  refFromString,
  SUPPORT_PERIODS,
  supportCircleTypedData,
  supporterNameTypedData,
  type CheckoutResponse,
  type MerchantOverview,
  type PayerResponse,
  type Plan,
  type SupportCircle,
  type SupportListResponse,
  type SupportResponse,
} from "@weir/shared";
import { getAddress, verifyTypedData, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { silentLogger } from "../log.js";
import { displaySymbol, type ApiNetwork } from "../network.js";
import { openTestDatabase } from "../test/db.js";
import { createApp, createRateLimits, type AppDeps, type UpdateMerchantResponse } from "./app.js";
import { createMerchantAuth } from "./auth.js";

const hub = getAddress("0x00000000000000000000000000000000000000a1");
const tAUSD = getAddress("0x00000000000000000000000000000000000000b1");
const USDC = getAddress("0x00000000000000000000000000000000000000b4");
const vault = getAddress("0x00000000000000000000000000000000000000b2");
const payer = getAddress("0x00000000000000000000000000000000000000d1");
const merchantAddress = getAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
const NOW = 1_800_000_000;

const network = (mainnet = false): ApiNetwork => ({
  chainId: mainnet ? 143 : 10143,
  chain: { id: 10143 } as ApiNetwork["chain"],
  rpcUrl: "http://unused",
  logChunkBlocks: 100,
  mainnet,
  deployment: { startBlock: 1, hub, domainName: "Weir", assets: { USDC, tAUSD }, testStablecoin: tAUSD, savings: { tAUSD: vault } },
});

const planBody = {
  name: "Pro",
  description: "Everything, monthly",
  asset: tAUSD,
  mode: "periodic",
  amount: "9990000",
  period: 2_592_000,
  trialDays: 0,
  maxPerCharge: "9990000",
  maxTotal: "119880000",
  termSeconds: 31_536_000,
};

const db = await openTestDatabase("routes");

describe.skipIf(db === undefined)("the HTTP API", () => {
  const sql = db!.sql;
  let clock = NOW * 1000;

  const app = (
    overrides: Partial<AppDeps> & {
      devAuth?: boolean;
      privy?: boolean;
      /** The wallets linked to the Privy user; the default is none. */
      privyWallets?: () => Promise<readonly Address[]>;
      mainnet?: boolean;
    } = {},
  ) => {
    const net = network(overrides.mainnet ?? false);
    const store = new Store(sql, { chainId: net.chainId, hub }, (asset: Address) => displaySymbol(net.deployment, asset));
    return createApp({
      network: net,
      store,
      auth: createMerchantAuth({
        devAuth: overrides.devAuth ?? true,
        logger: silentLogger,
        ...(overrides.privy === true
          ? {
              verifier: async (token: string) => {
                if (token !== "good-token") throw new Error("bad token");
                return "did:privy:user1";
              },
              wallets: overrides.privyWallets ?? (async () => []),
            }
          : {}),
      }),
      logger: silentLogger,
      allowedOrigins: ["http://localhost:5173"],
      health: async () => ({
        ok: true,
        chainId: net.chainId,
        hub,
        database: true,
        indexer: { running: true, standingBy: false, head: 10, indexedBlock: 10, lag: 0, caughtUp: true, lastTickAt: NOW, source: "rpc" },
        relayer: { configured: false },
      }),
      savingsVault: async () => ({ address: vault, name: "Test AUSD Savings", symbol: "stAUSD", asset: tAUSD, apyBps: 500 }),
      verifySignature: (args) => verifyTypedData(args),
      faucetAmount: 100_000_000n,
      webhookPolicy: { requireHttps: false, allowPrivateHosts: false },
      clientIp: (c) => c.req.header("x-test-ip") ?? "1.1.1.1",
      now: () => clock,
      ...overrides,
    });
  };

  const dev = (address: Address = merchantAddress) => ({ authorization: `Dev ${address.toLowerCase()}` });
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  beforeEach(async () => {
    await db!.reset();
    clock = NOW * 1000;
  });

  afterAll(async () => {
    await db?.close();
  });

  describe("errors, CORS and health", () => {
    it("answers unknown routes and bad JSON in the one error shape", async () => {
      const api = app();
      const missing = await api.request("/v1/nothing");
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: { code: "not_found", message: "No route GET /v1/nothing" } });
      const bad = await api.request("/v1/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: { code: "bad_request", message: "The body must be JSON" } });
      const huge = await api.request("/v1/faucet", json({ address: "x".repeat(70_000) }));
      expect(huge.status).toBe(413);
      expect(await huge.json()).toEqual({ error: { code: "bad_request", message: "The body is larger than 64 KiB" } });
    });

    it("allows the configured origin and no other", async () => {
      const api = app();
      const allowed = await api.request("/health", { headers: { origin: "http://localhost:5173" } });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      const other = await api.request("/health", { headers: { origin: "https://evil.example" } });
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
      const preflight = await api.request("/v1/merchant", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173", "access-control-request-method": "PUT", "access-control-request-headers": "authorization,content-type" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");
      // Turning reminders off is a cross-origin DELETE.
      expect(preflight.headers.get("access-control-allow-methods")).toContain("DELETE");
    });

    it("reports health", async () => {
      const response = await app().request("/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, indexer: { head: 10, lag: 0 } });
    });
  });

  describe("merchant sign-in", () => {
    it("answers 503 when neither Privy nor dev auth is configured", async () => {
      const response = await app({ devAuth: false }).request("/v1/merchant", { headers: dev() });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "not_configured" } });
    });

    it("with dev auth on and no Privy: Dev works, Bearer is 503, nothing is 401", async () => {
      const api = app();
      expect((await api.request("/v1/merchant")).status).toBe(401);
      expect((await api.request("/v1/merchant", { headers: { authorization: "Bearer x" } })).status).toBe(503);
      expect((await api.request("/v1/merchant", { headers: { authorization: "Dev nope" } })).status).toBe(401);
      const response = await api.request("/v1/merchant", { headers: dev() });
      expect(response.status).toBe(200);
      const profile = (await response.json()) as { id: string; payoutAddress: string; name: string };
      expect(profile).toMatchObject({ payoutAddress: merchantAddress, name: "", createdAt: NOW });
      expect(profile.id).toMatch(/^mer_[a-z2-7]{16}$/);
      // The same merchant on every request.
      expect(((await (await api.request("/v1/merchant", { headers: dev() })).json()) as { id: string }).id).toBe(profile.id);
    });

    it("verifies Privy tokens and refuses Dev when dev auth is off", async () => {
      const api = app({ devAuth: false, privy: true });
      expect((await api.request("/v1/merchant", { headers: { authorization: "Bearer bad" } })).status).toBe(401);
      expect((await api.request("/v1/merchant", { headers: dev() })).status).toBe(401);
      const response = await api.request("/v1/merchant", { headers: { authorization: "Bearer good-token" } });
      expect(response.status).toBe(200);
      // A Privy merchant has no payout address until it sets one.
      expect(await response.json()).toMatchObject({ payoutAddress: zeroAddress });
      const plan = await api.request("/v1/merchant/plans", json(planBody, { authorization: "Bearer good-token" }));
      expect(plan.status).toBe(400);
      expect(await plan.json()).toMatchObject({ error: { message: expect.stringMatching(/Set a payout address/) } });
    });
  });

  describe("payout ownership", () => {
    const embedded = getAddress("0x00000000000000000000000000000000000000e1");
    const external = getAddress("0x00000000000000000000000000000000000000e2");
    const stranger = getAddress("0x00000000000000000000000000000000000000e3");
    const bearer = { authorization: "Bearer good-token" };

    it("starts a Privy merchant on its embedded wallet and takes only wallets linked to it", async () => {
      let linked: Address[] = [embedded];
      let lookups = 0;
      const api = app({
        devAuth: false,
        privy: true,
        privyWallets: async () => {
          lookups += 1;
          return linked;
        },
      });
      const put = (body: unknown) => api.request("/v1/merchant", { ...json(body, bearer), method: "PUT" });

      expect(await (await api.request("/v1/merchant", { headers: bearer })).json()).toMatchObject({ payoutAddress: embedded });
      // A returning merchant is not looked up again.
      await api.request("/v1/merchant", { headers: bearer });
      expect(lookups).toBe(1);

      const refused = await put({ payoutAddress: stranger });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: { message: expect.stringMatching(/linked to your account/) } });

      // Linked a moment ago: the cached answer misses it, the fresh one has it.
      linked = [embedded, external];
      const accepted = await put({ payoutAddress: external });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ payoutAddress: external });
    });

    it("answers 503 when the linked wallets cannot be read, and signs a new merchant in regardless", async () => {
      const api = app({
        devAuth: false,
        privy: true,
        privyWallets: async () => {
          throw new Error("privy is down");
        },
      });
      const profile = await api.request("/v1/merchant", { headers: bearer });
      expect(profile.status).toBe(200);
      expect(await profile.json()).toMatchObject({ payoutAddress: zeroAddress });
      const put = await api.request("/v1/merchant", { ...json({ payoutAddress: embedded }, bearer), method: "PUT" });
      expect(put.status).toBe(503);
      expect(await put.json()).toMatchObject({ error: { code: "not_configured" } });
    });

    it("holds a dev merchant to the address it signed in as", async () => {
      const api = app();
      const put = (body: unknown) => api.request("/v1/merchant", { ...json(body, dev()), method: "PUT" });
      expect((await put({ payoutAddress: stranger })).status).toBe(400);
      expect((await put({ payoutAddress: merchantAddress })).status).toBe(200);
    });
  });

  describe("the merchant profile", () => {
    it("updates, and returns the webhook secret exactly once", async () => {
      const api = app();
      const put = (body: unknown) => api.request("/v1/merchant", { ...json(body, dev()), method: "PUT" });

      const first = (await (await put({ name: "Acme", webhookUrl: "https://acme.example/hooks" })).json()) as UpdateMerchantResponse;
      expect(first).toMatchObject({ name: "Acme", webhookUrl: "https://acme.example/hooks" });
      expect(first.webhookSecret).toMatch(/^whsec_/);

      const second = (await (await put({ webhookUrl: "https://acme.example/other" })).json()) as UpdateMerchantResponse;
      expect(second.webhookUrl).toBe("https://acme.example/other");
      expect(second.webhookSecret).toBeUndefined();

      const removed = (await (await put({ webhookUrl: null })).json()) as UpdateMerchantResponse;
      expect(removed.webhookUrl).toBeUndefined();
      const again = (await (await put({ webhookUrl: "https://acme.example/hooks" })).json()) as UpdateMerchantResponse;
      expect(again.webhookSecret).toBeUndefined();
    });

    it("refuses a bad payout address, a private webhook host and unknown fields", async () => {
      const api = app();
      const put = (body: unknown) => api.request("/v1/merchant", { ...json(body, dev()), method: "PUT" });
      expect(await (await put({ payoutAddress: zeroAddress })).json()).toMatchObject({ error: { message: expect.stringMatching(/zero address or the hub/) } });
      expect(await (await put({ payoutAddress: hub })).json()).toMatchObject({ error: { message: expect.stringMatching(/zero address or the hub/) } });
      expect(await (await put({ webhookUrl: "http://169.254.169.254/latest" })).json()).toMatchObject({ error: { message: expect.stringMatching(/public host/) } });
      expect(await (await put({ email: "a@b.c" })).json()).toMatchObject({ error: { message: expect.stringMatching(/unexpected field email/) } });
    });
  });

  describe("savings", () => {
    it("lists the vault offered for each asset that has one", async () => {
      const response = await app().request("/v1/savings");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        vaults: [{ asset: tAUSD, assetSymbol: "tAUSD", address: vault, name: "Test AUSD Savings", symbol: "stAUSD", apyBps: 500 }],
      });
    });

    it("refuses a malformed savings move before it reaches the chain", async () => {
      const api = app();
      const body = {
        direction: "withdraw",
        owner: payer,
        asset: tAUSD,
        amount: "1000000",
        deadline: NOW + 600,
        signature: `0x${"11".repeat(65)}`,
      };
      const missing = await api.request("/v1/relay/savings", json(body));
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({ error: { message: expect.stringMatching(/needs maxShares/) } });
      const stray = await api.request("/v1/relay/savings", json({ ...body, direction: "deposit", maxShares: "5" }));
      expect(await stray.json()).toMatchObject({ error: { message: expect.stringMatching(/withdrawals only/) } });
    });
  });

  describe("family support", () => {
    const recipient = privateKeyToAccount(generatePrivateKey());
    const supporter = privateKeyToAccount(generatePrivateKey());
    const session = privateKeyToAccount(generatePrivateKey());

    const openBody = async (overrides: { signer?: typeof recipient; period?: number; asset?: Address; currency?: string } = {}) => {
      const circle = {
        recipient: recipient.address,
        name: "Mum",
        note: "Groceries and medicine",
        currency: overrides.currency ?? "PKR",
        asset: overrides.asset ?? tAUSD,
        period: overrides.period ?? SUPPORT_PERIODS.month,
        goal: 200_000_000n,
        nonce: 7n,
        deadline: BigInt(NOW + 600),
      };
      const signature = await (overrides.signer ?? recipient).signTypedData(supportCircleTypedData({ chainId: 10143, ...circle }));
      return { ...circle, goal: circle.goal.toString(), nonce: circle.nonce.toString(), deadline: NOW + 600, signature };
    };

    async function seedContribution(id: number, circleId: string, amount: number, payTo: Address = recipient.address, payments = 12): Promise<void> {
      const tx = `0x${String(id).padStart(64, "0")}`;
      await sql`
        INSERT INTO mandates (chain_id, hub, id, payer, merchant, asset, vault, manager, amount, period, next_charge_at,
                              max_per_charge, max_total, total_charged, expires_at, paused_at, status, ref,
                              created_at, created_block, created_tx, needs_refresh)
        VALUES (10143, ${hub}, ${id}, ${supporter.address}, ${payTo}, ${tAUSD}, ${zeroAddress}, ${session.address}, ${amount},
                ${SUPPORT_PERIODS.month}, ${NOW + 1_000}, ${amount}, ${amount * payments}, ${amount}, ${NOW + 1_000_000}, 0, 'Active',
                ${refFromString(circleId)}, ${NOW - 100 + id}, ${id}, ${tx}, false)`;
      await sql`INSERT INTO hub_events (chain_id, hub, tx_hash, log_index, block_number, block_hash, block_time, event, mandate_id, args)
                VALUES (10143, ${hub}, ${tx}, 1, ${id}, '0x00', ${NOW - 10}, 'Charged', ${id}, '{}')`;
      await sql`INSERT INTO charges (chain_id, hub, tx_hash, log_index, block_number, block_time, mandate_id, kind, amount)
                VALUES (10143, ${hub}, ${tx}, 1, ${id}, ${NOW - 10}, ${id}, 'charged', ${amount})`;
    }

    it("opens a circle only on its recipient's signature, once per signature", async () => {
      const api = app();
      const body = await openBody();
      const opened = await api.request("/v1/support", json(body));
      expect(opened.status).toBe(201);
      const circle = (await opened.json()) as SupportCircle;
      expect(circle).toMatchObject({ recipient: recipient.address, name: "Mum", currency: "PKR", assetSymbol: "tAUSD", period: 2_592_000, goal: "200000000" });
      expect(circle.id).toMatch(/^sup_[a-z2-7]{16}$/);

      // The same signed request again is the same circle.
      expect(((await (await api.request("/v1/support", json(body))).json()) as SupportCircle).id).toBe(circle.id);

      const forged = await api.request("/v1/support", json(await openBody({ signer: supporter })));
      expect(forged.status).toBe(400);
      expect(await forged.json()).toMatchObject({ error: { message: expect.stringMatching(/not the recipient's/) } });
      expect((await api.request("/v1/support", json(await openBody({ period: 86_400 })))).status).toBe(400);
      expect((await api.request("/v1/support", json(await openBody({ asset: vault })))).status).toBe(400);
      expect((await api.request("/v1/support", json(await openBody({ currency: "XYZ" })))).status).toBe(400);
      // A circle may show no local currency at all.
      const plain = (await (await api.request("/v1/support", json(await openBody({ currency: "" })))).json()) as SupportCircle;
      expect(plain.currency).toBe("");

      const listed = (await (await api.request(`/v1/recipients/${recipient.address}/support`)).json()) as SupportListResponse;
      // Opened in the same second, so either order is newest first.
      expect(listed.circles.map((c) => c.id).sort()).toEqual([plain.id, circle.id].sort());
    });

    it("adds up who gives, what arrives, and the names supporters choose", async () => {
      const api = app();
      const circle = (await (await api.request("/v1/support", json(await openBody()))).json()) as SupportCircle;
      await seedContribution(1, circle.id, 50_000_000);
      await seedContribution(2, circle.id, 25_000_000);
      // Carries the circle's ref but pays someone else: never counted.
      await seedContribution(3, circle.id, 99_000_000, payer);
      // Sent once: it arrived, but nothing more comes from it each month.
      await seedContribution(5, circle.id, 10_000_000, recipient.address, 1);

      const view = (await (await api.request(`/v1/support/${circle.id}`)).json()) as SupportResponse;
      expect(view.supporters.map((s) => s.mandateId).sort()).toEqual(["1", "2", "5"]);
      expect(view.supporters.find((s) => s.mandateId === "5")?.once).toBe(true);
      expect(view.supporters.find((s) => s.mandateId === "1")?.once).toBe(false);
      expect(view.committedPerPeriod).toBe("75000000");
      expect(view.received).toBe("85000000");
      expect(view.savingsVault?.address).toBe(vault);

      // The payer's own view names the circle.
      const payerView = (await (await api.request(`/v1/payers/${supporter.address}`)).json()) as PayerResponse;
      expect(payerView.mandates.find((m) => m.id === "1")?.support).toEqual({ id: circle.id, name: "Mum" });
      expect(payerView.mandates.find((m) => m.id === "3")?.support).toBeUndefined();

      const name = async (signer: typeof recipient, mandateId: string, text: string) => {
        const deadline = NOW + 600;
        const signature = await signer.signTypedData(
          supporterNameTypedData({ chainId: 10143, hub, mandateId: BigInt(mandateId), name: text, deadline: BigInt(deadline) }),
        );
        return api.request(`/v1/support/${circle.id}/supporters/${mandateId}/name`, {
          ...json({ name: text, signer: signer.address, deadline, signature }),
          method: "PUT",
        });
      };
      // The session key that manages the payment may name it; nobody else may.
      expect((await name(session, "1", "Ali, London")).status).toBe(200);
      expect((await name(recipient, "2", "Not me")).status).toBe(400);
      expect((await name(supporter, "3", "Elsewhere")).status).toBe(404);
      const named = (await (await api.request(`/v1/support/${circle.id}`)).json()) as SupportResponse;
      expect(named.supporters.find((s) => s.mandateId === "1")?.name).toBe("Ali, London");

      // Named before the indexer has the mandate: kept, and shown once it is indexed with that signer.
      expect((await name(session, "4", "Sara, Toronto")).status).toBe(202);
      // A stranger's name for the same mandate is kept against the stranger and never shown.
      expect((await name(recipient, "4", "Impostor")).status).toBe(202);
      await seedContribution(4, circle.id, 10_000_000);
      const later = (await (await api.request(`/v1/support/${circle.id}`)).json()) as SupportResponse;
      expect(later.supporters.find((s) => s.mandateId === "4")?.name).toBe("Sara, Toronto");
    });
  });

  describe("push reminders", () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const session = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    const endpoint = "https://push.example/send/abc123";
    const keys = { p256dh: `B${"a".repeat(86)}`, auth: "c".repeat(22) };
    const pushKey = `B${"k".repeat(86)}`;

    const subscribeBody = async (signer: typeof owner, url = endpoint) => {
      const deadline = NOW + 600;
      const signature = await signer.signTypedData(
        pushSubscriptionTypedData({ chainId: 10143, payer: owner.address, endpoint: url, deadline: BigInt(deadline) }),
      );
      return { payer: owner.address, signer: signer.address, subscription: { endpoint: url, keys, expirationTime: null }, deadline, signature };
    };

    it("is off without a key, and hands out the key when on", async () => {
      expect((await app().request("/v1/push/key")).status).toBe(404);
      const on = await app({ pushPublicKey: pushKey }).request("/v1/push/key");
      expect(await on.json()).toEqual({ publicKey: pushKey });
    });

    it("registers a browser only for someone who can already stop the payer's payments", async () => {
      const api = app({ pushPublicKey: pushKey });
      await sql`
        INSERT INTO mandates (chain_id, hub, id, payer, merchant, asset, vault, manager, amount, period, next_charge_at,
                              max_per_charge, max_total, total_charged, expires_at, paused_at, status, ref,
                              created_at, created_block, created_tx, needs_refresh)
        VALUES (10143, ${hub}, 1, ${owner.address}, ${merchantAddress}, ${tAUSD}, ${zeroAddress}, ${session.address}, 9990000,
                2592000, ${NOW + 1_000}, 9990000, 119880000, 0, ${NOW + 1_000_000}, 0, 'Active', ${refFromString("x")},
                ${NOW}, 1, ${`0x${"1".padStart(64, "0")}`}, false)`;

      // The session key that manages a payment, and the payer themselves, may; a stranger may not.
      expect((await api.request("/v1/push/subscriptions", json(await subscribeBody(session)))).status).toBe(201);
      expect((await api.request("/v1/push/subscriptions", json(await subscribeBody(owner, `${endpoint}-2`)))).status).toBe(201);
      const refused = await api.request("/v1/push/subscriptions", json(await subscribeBody(stranger, `${endpoint}-3`)));
      expect(refused.status).toBe(400);
      expect((await api.request("/v1/push/subscriptions", json(await subscribeBody(owner, "http://push.example/x")))).status).toBe(400);

      const store = new Store(sql, { chainId: 10143, hub }, () => "tAUSD");
      expect((await store.pushSubscriptionsFor(owner.address)).map((s) => s.endpoint).sort()).toEqual([endpoint, `${endpoint}-2`]);

      const removed = await api.request("/v1/push/subscriptions", { ...json({ endpoint }), method: "DELETE" });
      expect(removed.status).toBe(204);
      expect((await store.pushSubscriptionsFor(owner.address)).map((s) => s.endpoint)).toEqual([`${endpoint}-2`]);
    });
  });

  describe("plans and checkout", () => {
    it("creates, lists, reads, deactivates, and serves the checkout", async () => {
      const api = app();
      await api.request("/v1/merchant", { ...json({ name: "Acme" }, dev()), method: "PUT" });
      const created = await api.request("/v1/merchant/plans", json(planBody, dev()));
      expect(created.status).toBe(201);
      const plan = (await created.json()) as Plan;
      expect(plan).toMatchObject({
        name: "Pro",
        asset: tAUSD,
        assetSymbol: "tAUSD",
        amount: "9990000",
        active: true,
        createdAt: NOW,
        merchant: { name: "Acme", payoutAddress: merchantAddress },
      });
      expect(plan.id).toMatch(/^pln_[a-z2-7]{16}$/);

      const list = (await (await api.request("/v1/merchant/plans", { headers: dev() })).json()) as { plans: Plan[] };
      expect(list.plans.map((p) => p.id)).toEqual([plan.id]);
      expect((await api.request(`/v1/merchant/plans/${plan.id}`, { headers: dev() })).status).toBe(200);

      // Another merchant can neither read nor change it.
      const stranger = dev(payer);
      expect((await api.request(`/v1/merchant/plans/${plan.id}`, { headers: stranger })).status).toBe(404);
      expect((await api.request(`/v1/merchant/plans/${plan.id}`, { ...json({ active: false }, stranger), method: "PATCH" })).status).toBe(404);

      const checkout = (await (await api.request(`/v1/checkout/${plan.id}`)).json()) as CheckoutResponse;
      expect(checkout).toEqual({
        plan,
        chainId: 10143,
        hub,
        domainName: "Weir",
        savingsVault: { address: vault, name: "Test AUSD Savings", symbol: "stAUSD", apyBps: 500 },
      });

      const patched = await api.request(`/v1/merchant/plans/${plan.id}`, { ...json({ active: false }, dev()), method: "PATCH" });
      expect(await patched.json()).toMatchObject({ id: plan.id, active: false });
      expect(((await (await api.request(`/v1/checkout/${plan.id}`)).json()) as CheckoutResponse).plan.active).toBe(false);
    });

    it("offers the savings vault only for the asset it saves", async () => {
      const api = app();
      const plan = (await (await api.request("/v1/merchant/plans", json({ ...planBody, asset: USDC }, dev()))).json()) as Plan;
      const checkout = (await (await api.request(`/v1/checkout/${plan.id}`)).json()) as CheckoutResponse;
      expect(checkout.savingsVault).toBeUndefined();
    });

    it("answers 404 for an unknown plan and 400 for one the hub would refuse", async () => {
      const api = app();
      expect((await api.request("/v1/checkout/pln_aaaaaaaaaaaaaaaa")).status).toBe(404);
      expect((await api.request("/v1/checkout/..%2Fetc")).status).toBe(404);
      const bad = await api.request("/v1/merchant/plans", json({ ...planBody, period: 30 }, dev()));
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: { code: "bad_request", message: expect.stringMatching(/period must be between 60/) } });
    });
  });

  describe("payers and the overview", () => {
    async function seedMandates(planId: string): Promise<void> {
      const rows: [number, string, string, string, number, string][] = [
        // id, merchant, status, ref, period, total
        [1, merchantAddress, "Active", refFromString(planId), 2_592_000, "0"],
        [2, merchantAddress, "Delinquent", refFromString(planId), 2_592_000, "0"],
        // Carries the plan's ref but pays someone else: never labelled with the plan.
        [3, payer, "Active", refFromString(planId), 2_592_000, "0"],
        [4, merchantAddress, "Active", refFromString("other"), 0, "0"],
      ];
      for (const [id, merchant, status, ref, period, total] of rows) {
        await sql`
          INSERT INTO mandates (chain_id, hub, id, payer, merchant, asset, vault, manager, amount, period, next_charge_at,
                                max_per_charge, max_total, total_charged, expires_at, paused_at, status, ref,
                                created_at, created_block, created_tx, needs_refresh)
          VALUES (10143, ${hub}, ${id}, ${payer}, ${merchant}, ${tAUSD}, ${zeroAddress}, ${zeroAddress}, 9990000, ${period},
                  ${NOW}, 9990000, 119880000, ${total}, ${NOW + 1_000_000}, 0, ${status}, ${ref}, ${NOW - 100 + id}, ${id},
                  ${`0x${String(id).padStart(64, "0")}`}, false)`;
        await sql`INSERT INTO hub_events (chain_id, hub, tx_hash, log_index, block_number, block_hash, block_time, event, mandate_id, args)
                  VALUES (10143, ${hub}, ${`0x${String(id).padStart(64, "0")}`}, 1, ${id}, '0x00', ${NOW - 10}, 'Charged', ${id}, '{}')`;
        await sql`INSERT INTO charges (chain_id, hub, tx_hash, log_index, block_number, block_time, mandate_id, kind, amount)
                  VALUES (10143, ${hub}, ${`0x${String(id).padStart(64, "0")}`}, 1, ${id}, ${NOW - 10}, ${id}, 'charged', 9990000)`;
      }
    }

    it("serves a payer's mandates with standing and the plan join, and their charges", async () => {
      const api = app();
      await api.request("/v1/merchant", { ...json({ name: "Acme" }, dev()), method: "PUT" });
      const plan = (await (await api.request("/v1/merchant/plans", json(planBody, dev()))).json()) as Plan;
      await seedMandates(plan.id);

      expect((await api.request("/v1/payers/0x1234")).status).toBe(400);
      const body = (await (await api.request(`/v1/payers/${payer.toLowerCase()}`)).json()) as PayerResponse;
      expect(body.mandates.map((m) => [m.id, m.standing, m.plan?.name ?? null])).toEqual([
        ["4", "Active", null],
        ["3", "Active", null],
        ["2", "Past due", "Pro"],
        ["1", "Active", "Pro"],
      ]);
      expect(body.mandates[3]).toMatchObject({
        payer,
        merchant: merchantAddress,
        assetSymbol: "tAUSD",
        amount: "9990000",
        maxTotal: "119880000",
        createdAt: NOW - 99,
        plan: { id: plan.id, name: "Pro", description: "Everything, monthly", mode: "periodic", merchantName: "Acme" },
      });
      expect(body.charges).toHaveLength(4);
      expect(body.charges[0]).toMatchObject({ kind: "charged", amount: "9990000", payer, asset: tAUSD, timestamp: NOW - 10 });
    });

    it("computes the overview from the mandates that pay the merchant", async () => {
      const api = app();
      const plan = (await (await api.request("/v1/merchant/plans", json(planBody, dev()))).json()) as Plan;
      await seedMandates(plan.id);
      const overview = (await (await api.request("/v1/merchant/overview", { headers: dev() })).json()) as MerchantOverview;
      expect(overview.plans.map((p) => p.id)).toEqual([plan.id]);
      expect(overview.mandates.map((m) => m.id)).toEqual(["4", "2", "1"]);
      expect(overview.charges).toHaveLength(3);
      expect(overview.stats).toEqual({
        activeMandates: 2,
        pastDue: 1,
        mrr: { tAUSD: "9990000" },
        collected30d: { tAUSD: "29970000" },
      });
    });
  });

  describe("relay and faucet guards", () => {
    it("answers 503 without a relayer and 404 for the faucet on Mainnet", async () => {
      const install = await app().request("/v1/relay/action", json({ mandateId: "1", action: "cancel", signer: payer, nonce: "1", deadline: NOW + 60, signature: "0x11" }));
      expect(install.status).toBe(503);
      expect(await install.json()).toMatchObject({ error: { code: "not_configured" } });
      const faucet = await app({ mainnet: true }).request("/v1/faucet", json({ address: payer }));
      expect(faucet.status).toBe(404);
      expect((await app().request("/v1/faucet", json({ address: payer }))).status).toBe(503);
    });

    it("rate limits the relay per IP with a retry-after", async () => {
      const api = app({ limits: createRateLimits(() => clock) });
      const body = { mandateId: "1", action: "cancel", signer: payer, nonce: "1", deadline: NOW + 60, signature: "0x11" };
      for (let i = 0; i < 30; i += 1) {
        expect((await api.request("/v1/relay/action", json(body, { "x-test-ip": "9.9.9.9" }))).status).toBe(503);
      }
      const limited = await api.request("/v1/relay/action", json(body, { "x-test-ip": "9.9.9.9" }));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("2");
      expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
      expect((await api.request("/v1/relay/action", json(body, { "x-test-ip": "8.8.8.8" }))).status).toBe(503);
      clock += 2_000;
      expect((await api.request("/v1/relay/action", json(body, { "x-test-ip": "9.9.9.9" }))).status).toBe(503);
    });

    it("validates relay bodies before anything else", async () => {
      const response = await app().request("/v1/relay/install", json({ payer }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { message: "terms is required" } });
    });
  });
});
