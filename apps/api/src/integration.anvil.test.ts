/**
 * The whole API against the real contracts on a local anvil node, the way the web app uses it.
 *
 * A merchant signs in with dev auth, sets a webhook and creates a plan; the checkout serves it; a
 * payer that never holds gas is funded by the faucet and installs a mandate from two signatures
 * through `/v1/relay/install`; a keeper charges it; the payer hands the manager role to a new key,
 * which cancels; and every step is read back from `/v1/payers/:address` and the merchant overview
 * once the indexer catches up, with the webhooks checked against their signatures.
 *
 * Runs whenever `anvil` is on the PATH and Postgres answers; skips cleanly otherwise.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { serve, type ServerType } from "@hono/node-server";
import {
  actionTypedData,
  createMandateTypedData,
  hubDomain,
  mandateHubAbi,
  permitTypedData,
  randomNonce,
  refFromString,
  setManagerTypedData,
  stablecoinAbi,
  type CheckoutResponse,
  type InstallResponse,
  type MandateView,
  type MerchantOverview,
  type PayerResponse,
  type PayoutResponse,
  type Plan,
  type RelayResponse,
} from "@weir/shared";
import { createWalletClient, http, parseAbi, parseEventLogs, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { UpdateMerchantResponse } from "./http/app.js";
import { createLogger, silentLogger } from "./log.js";
import { createApiService, type ApiService } from "./service.js";
import { anvilAccount, anvilAvailable, deployWeir, startAnvil, type AnvilNode, type WeirOnAnvil } from "./test/anvil.js";
import { openTestDatabase, type TestDatabase } from "./test/db.js";
import { verifyWebhookSignature } from "./webhooks/sign.js";

const enabled = anvilAvailable();
const db: TestDatabase | undefined = enabled ? await openTestDatabase("anvil") : undefined;

interface Hook {
  body: string;
  signature: string | undefined;
}

describe.skipIf(!enabled || db === undefined)("the API on a local node", () => {
  let node: AnvilNode;
  let weir: WeirOnAnvil;
  let service: ApiService;
  let server: ServerType;
  let hookServer: Server;
  let base: string;
  const hooks: Hook[] = [];

  const merchantWallet = privateKeyToAccount(generatePrivateKey());
  const merchant = merchantWallet.address;
  const payer = privateKeyToAccount(generatePrivateKey());
  const session = privateKeyToAccount(generatePrivateKey());
  const dev = { authorization: `Dev ${merchant}` };

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
      const value = await read();
      if (done(value)) return value;
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const payerView = () => call<PayerResponse>(`/v1/payers/${payer.address}`).then((r) => r.body);
  const first = (view: PayerResponse): MandateView | undefined => view.mandates.find((m) => m.id === "1");

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

    service = createApiService({
      network: { chainId: anvil.id, chain: anvil, rpcUrl: node.rpcUrl, logChunkBlocks: 100, mainnet: false, deployment: weir.deployment },
      sql: db!.sql,
      publicClient: node.publicClient,
      logger: process.env.WEIR_TEST_LOG === "1" ? createLogger("api-test") : silentLogger,
      relayerAccount: anvilAccount(1),
      devAuth: true,
      faucetAmount: 100_000_000n,
      allowedOrigins: [],
      indexer: true,
      indexerOptions: { pollMs: 100, reorgWindowBlocks: 5 },
      webhookOptions: { pollMs: 100, backoffMs: [200, 200, 200] },
    });
    service.start();
    server = serve({ fetch: service.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
    await service?.stop();
    await new Promise<void>((resolve) => (hookServer === undefined ? resolve() : hookServer.close(() => resolve())));
    await node?.stop();
    await db?.close();
  });

  let plan: Plan;
  let checkout: CheckoutResponse;
  let webhookSecret: string;
  let installBody: Record<string, unknown>;
  let install: InstallResponse;
  let signInstall: (nonce: bigint) => Promise<Record<string, unknown>>;

  it("serves health once the indexer has caught up", async () => {
    const health = await until(
      () => call<{ ok: boolean; indexer: { lag: number | null } }>("/health").then((r) => r.body),
      (h) => h.ok && h.indexer.lag === 0,
      "the indexer",
    );
    expect(health).toMatchObject({ chainId: anvil.id, hub: weir.hub, relayer: { configured: true, address: anvilAccount(1).address } });
  });

  it("lets a merchant sign in, set a webhook and create a plan, and serves its checkout", async () => {
    const profile = await call<UpdateMerchantResponse>("/v1/merchant", {
      method: "PUT",
      headers: dev,
      body: { name: "Acme", webhookUrl: `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hooks` },
    });
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({ name: "Acme", payoutAddress: merchant });
    webhookSecret = profile.body.webhookSecret ?? "";
    expect(webhookSecret).toMatch(/^whsec_/);

    const created = await call<Plan>("/v1/merchant/plans", {
      headers: dev,
      body: {
        name: "Pro",
        description: "Everything, monthly",
        asset: weir.token,
        mode: "periodic",
        amount: "5000000",
        period: 2_592_000,
        trialDays: 0,
        maxPerCharge: "5000000",
        maxTotal: "60000000",
        termSeconds: 31_536_000,
      },
    });
    expect(created.status).toBe(201);
    plan = created.body;

    const response = await call<CheckoutResponse>(`/v1/checkout/${plan.id}`);
    checkout = response.body;
    expect(checkout).toMatchObject({
      chainId: anvil.id,
      hub: weir.hub,
      domainName: "Weir",
      plan: { id: plan.id, assetSymbol: "tAUSD", merchant: { name: "Acme", payoutAddress: merchant } },
      savingsVault: { address: weir.vault, name: "Test AUSD Savings", symbol: "stAUSD", apyBps: 500 },
    });
  });

  it("funds a new account from the faucet once per cooldown", async () => {
    const granted = await call<{ transaction: string; amount: string; asset: Address }>("/v1/faucet", { body: { address: payer.address } });
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ amount: "100000000", asset: weir.token });
    const balance = await node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "balanceOf", args: [payer.address] });
    expect(balance).toBe(100_000_000n);

    const again = await call<{ error: { code: string } }>("/v1/faucet", { body: { address: payer.address } });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe("rate_limited");
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(590);
  });

  it("installs a mandate from a permit and a signature, with no gas from the payer", async () => {
    const now = Math.floor(Date.now() / 1000);
    const domain = hubDomain({ name: checkout.domainName, chainId: checkout.chainId, address: checkout.hub });
    const permitNonce = await node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "nonces", args: [payer.address] });
    const maxTotal = BigInt(plan.maxTotal);
    const permitSignature = await payer.signTypedData(
      permitTypedData({
        token: { address: weir.token, permit: { name: "Test AUSD", version: "1" } },
        chainId: checkout.chainId,
        owner: payer.address,
        spender: checkout.hub,
        value: maxTotal,
        nonce: permitNonce,
        deadline: BigInt(now + 600),
      }),
    );
    const terms = {
      merchant: plan.merchant.payoutAddress,
      asset: plan.asset,
      vault: zeroAddress,
      manager: session.address,
      amount: BigInt(plan.amount),
      period: plan.period,
      startAt: 0n,
      maxPerCharge: BigInt(plan.maxPerCharge),
      maxTotal,
      expiresAt: BigInt(now + plan.termSeconds),
      ref: refFromString(plan.id),
    };
    signInstall = async (nonce) => ({
      permit: { token: weir.token, owner: payer.address, value: maxTotal.toString(), deadline: now + 600, signature: permitSignature },
      payer: payer.address,
      terms: {
        ...terms,
        amount: terms.amount.toString(),
        startAt: 0,
        maxPerCharge: terms.maxPerCharge.toString(),
        maxTotal: terms.maxTotal.toString(),
        expiresAt: Number(terms.expiresAt),
      },
      nonce: nonce.toString(),
      deadline: now + 600,
      signature: await payer.signTypedData(createMandateTypedData({ domain, payer: payer.address, terms, nonce, deadline: BigInt(now + 600) })),
    });
    installBody = await signInstall(randomNonce());

    const response = await call<InstallResponse>("/v1/relay/install", { body: installBody });
    expect(response.status).toBe(200);
    install = response.body;
    expect(install.mandateId).toBe("1");
    expect(install.transactions.permit).toMatch(/^0x[0-9a-f]{64}$/);

    const allowance = await node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "allowance", args: [payer.address, weir.hub] });
    expect(allowance).toBe(maxTotal);
    expect(await node.publicClient.getBalance({ address: payer.address })).toBe(0n);

    // Monad bills the limit: the relayer states the estimate plus a tight margin, never a flat ceiling.
    const receipt = await node.publicClient.getTransactionReceipt({ hash: install.transactions.create });
    const tx = await node.publicClient.getTransaction({ hash: install.transactions.create });
    expect(tx.gas).toBeLessThan((receipt.gasUsed * 115n) / 100n + 5_000n);

    const view = await until(payerView, (v) => v.mandates.length === 1 && v.mandates[0]?.createdTx === install.transactions.create, "the install to be indexed");
    expect(view.mandates[0]).toMatchObject<Partial<MandateView>>({
      id: "1",
      payer: payer.address,
      merchant,
      asset: weir.token,
      assetSymbol: "tAUSD",
      manager: session.address,
      amount: "5000000",
      maxTotal: "60000000",
      totalCharged: "0",
      status: "Active",
      standing: "Active",
      ref: refFromString(plan.id),
      plan: { id: plan.id, name: "Pro", description: "Everything, monthly", mode: "periodic", merchantName: "Acme" },
    });
  });

  it("refuses a replayed install by name, and skips a permit whose allowance is already there", async () => {
    const replay = await call<{ error: { code: string; message: string } }>("/v1/relay/install", { body: installBody });
    expect(replay.status).toBe(422);
    expect(replay.body.error.code).toBe("rejected_on_chain");
    expect(replay.body.error.message).toMatch(/^NonceAlreadyUsed\(/);

    // The same permit again, as if someone else had submitted it first: its nonce is spent, the
    // allowance it granted is there, so the relayer skips it rather than send a revert.
    const second = await call<InstallResponse>("/v1/relay/install", { body: await signInstall(randomNonce()) });
    expect(second.status).toBe(200);
    expect(second.body.mandateId).toBe("2");
    expect(second.body.transactions.permit).toBeUndefined();
  });

  it("indexes a keeper's charge and refreshes the mandate from the chain", async () => {
    const keeper = createWalletClient({ account: anvilAccount(2), chain: anvil, transport: http(node.rpcUrl) });
    const hash = await keeper.writeContract({ address: weir.hub, abi: mandateHubAbi, functionName: "charge", args: [1n] });
    await node.publicClient.waitForTransactionReceipt({ hash });

    const view = await until(payerView, (v) => v.charges.length === 1 && first(v)?.totalCharged === "5000000", "the charge to be indexed");
    expect(view.charges[0]).toMatchObject({ mandateId: "1", kind: "charged", amount: "5000000", payer: payer.address, merchant, asset: weir.token, transaction: hash });
    const onChain = await node.publicClient.readContract({ address: weir.hub, abi: mandateHubAbi, functionName: "getMandate", args: [1n] });
    expect(first(view)?.nextChargeAt).toBe(Number(onChain.nextChargeAt));
  });

  it("relays a manager change and the managers' actions, naming what the hub refuses", async () => {
    const domain = hubDomain({ name: checkout.domainName, chainId: checkout.chainId, address: checkout.hub });
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const successor = privateKeyToAccount(generatePrivateKey());

    const sign = async (signer: typeof session, action: "pause" | "cancel") => {
      const nonce = randomNonce();
      const signature = await signer.signTypedData(actionTypedData({ domain, mandateId: 1n, action, nonce, deadline: BigInt(deadline) }));
      return { mandateId: "1", action, signer: signer.address, nonce: nonce.toString(), deadline, signature };
    };

    const pause = await call<{ error: { code: string; message: string } }>("/v1/relay/action", { body: await sign(session, "pause") });
    expect(pause.status).toBe(422);
    expect(pause.body.error).toMatchObject({ code: "rejected_on_chain", message: expect.stringMatching(/^NotStreaming\(\)/) });

    const managerNonce = randomNonce();
    const managerSignature = await payer.signTypedData(
      setManagerTypedData({ domain, mandateId: 1n, manager: successor.address, nonce: managerNonce, deadline: BigInt(deadline) }),
    );
    const manager = await call<{ transaction: string }>("/v1/relay/manager", {
      body: { mandateId: "1", manager: successor.address, nonce: managerNonce.toString(), deadline, signature: managerSignature },
    });
    expect(manager.status).toBe(200);
    await until(payerView, (v) => first(v)?.manager === successor.address, "the manager change to be indexed");

    const stale = await call<{ error: { message: string } }>("/v1/relay/action", { body: await sign(session, "cancel") });
    expect(stale.status).toBe(422);
    expect(stale.body.error.message).toMatch(/^NotAuthorized\(\)/);

    const cancel = await call<{ transaction: string }>("/v1/relay/action", { body: await sign(successor, "cancel") });
    expect(cancel.status).toBe(200);
    expect(cancel.body.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    const cancelled = await until(payerView, (v) => first(v)?.status === "Cancelled", "the cancel to be indexed");
    expect(first(cancelled)?.standing).toBe("Cancelled");
  });

  it("moves savings in and out on the payer's permits, with no gas from the payer", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const vaultAbi = parseAbi([
      "function balanceOf(address) view returns (uint256)",
      "function previewWithdraw(uint256) view returns (uint256)",
      "function nonces(address) view returns (uint256)",
    ]);
    const balance = () =>
      node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "balanceOf", args: [payer.address] });
    const shares = () => node.publicClient.readContract({ address: weir.vault, abi: vaultAbi, functionName: "balanceOf", args: [payer.address] });

    const deposited = 10_000_000n;
    const depositSignature = await payer.signTypedData(
      permitTypedData({
        token: { address: weir.token, permit: { name: "Test AUSD", version: "1" } },
        chainId: checkout.chainId,
        owner: payer.address,
        spender: weir.router,
        value: deposited,
        nonce: await node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "nonces", args: [payer.address] }),
        deadline: BigInt(deadline),
      }),
    );
    const walletBefore = await balance();
    const deposit = await call<RelayResponse>("/v1/relay/savings", {
      body: { direction: "deposit", owner: payer.address, asset: weir.token, amount: deposited.toString(), deadline, signature: depositSignature },
    });
    expect(deposit.status).toBe(200);
    expect(await balance()).toBe(walletBefore - deposited);
    expect(await shares()).toBeGreaterThan(0n);

    // Out again: the permit is on the vault's shares, for exactly what the withdrawal burns.
    const withdrawn = 4_000_000n;
    const maxShares = await node.publicClient.readContract({ address: weir.vault, abi: vaultAbi, functionName: "previewWithdraw", args: [withdrawn] });
    const withdrawBody = {
      direction: "withdraw",
      owner: payer.address,
      asset: weir.token,
      amount: withdrawn.toString(),
      maxShares: maxShares.toString(),
      deadline,
      signature: await payer.signTypedData(
        permitTypedData({
          token: { address: weir.vault, permit: { name: "Test AUSD Savings", version: "1" } },
          chainId: checkout.chainId,
          owner: payer.address,
          spender: weir.router,
          value: maxShares,
          nonce: await node.publicClient.readContract({ address: weir.vault, abi: vaultAbi, functionName: "nonces", args: [payer.address] }),
          deadline: BigInt(deadline),
        }),
      ),
    };
    const walletMid = await balance();
    const withdraw = await call<RelayResponse>("/v1/relay/savings", { body: withdrawBody });
    expect(withdraw.status).toBe(200);
    expect(await balance()).toBe(walletMid + withdrawn);
    expect(await node.publicClient.getBalance({ address: payer.address })).toBe(0n);

    // The same permit again: used, and the allowance it gave is spent, so the simulation refuses it.
    const replay = await call<{ error: { code: string } }>("/v1/relay/savings", { body: withdrawBody });
    expect(replay.status).toBe(422);
    expect(replay.body.error.code).toBe("rejected_on_chain");
  });

  it("serves the merchant overview from the index", async () => {
    const overview = await call<MerchantOverview>("/v1/merchant/overview", { headers: dev });
    expect(overview.status).toBe(200);
    expect(overview.body.plans.map((p) => p.id)).toEqual([plan.id]);
    expect(overview.body.mandates.map((m) => [m.id, m.standing])).toEqual([
      ["2", "Active"],
      ["1", "Cancelled"],
    ]);
    expect(overview.body.charges).toHaveLength(1);
    expect(overview.body.stats).toEqual({ activeMandates: 1, pastDue: 0, mrr: { tAUSD: "5000000" }, collected30d: { tAUSD: "5000000" } });
  });

  it("delivers signed webhooks for what the indexer saw", async () => {
    await until(async () => hooks.length, (n) => n >= 4, "four webhooks");
    const events = hooks.map((hook) => {
      expect(verifyWebhookSignature(webhookSecret, hook.body, hook.signature, Math.floor(Date.now() / 1000))).toBe(true);
      return JSON.parse(hook.body) as { type: string; data: { mandate: MandateView; charge?: { amount: string } } };
    });
    expect(events.map((event) => [event.type, event.data.mandate.id])).toEqual([
      ["mandate.created", "1"],
      ["mandate.created", "2"],
      ["charge.succeeded", "1"],
      ["mandate.cancelled", "1"],
    ]);
    expect(events[2]?.data.charge?.amount).toBe("5000000");
    expect(events[0]?.data.mandate.plan?.name).toBe("Pro");
    const [row] = await db!.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'delivered'`;
    expect(row?.n).toBe(4);
  });
  it("pays a savings mandate from the balance once the savings run out, on the backup the install signed", async () => {
    // A payer of its own, so nothing above changes: it holds dollars, saves most of them, and
    // subscribes from savings with a backup permit on the dollars, all in one relayed transaction.
    const saver = anvilAccount(5);
    const saverWallet = createWalletClient({ account: saver, chain: anvil, transport: http(node.rpcUrl) });
    const vaultAbi = parseAbi([
      "function deposit(uint256 assets, address receiver) returns (uint256)",
      "function approve(address spender, uint256 amount) returns (bool)",
      "function transfer(address to, uint256 amount) returns (bool)",
      "function balanceOf(address owner) view returns (uint256)",
      "function previewWithdraw(uint256 assets) view returns (uint256)",
      "function nonces(address owner) view returns (uint256)",
    ]);
    const wait = (hash: `0x${string}`) => node.publicClient.waitForTransactionReceipt({ hash });
    const tokenBalance = (who: Address) =>
      node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "balanceOf", args: [who] });
    const shares = () => node.publicClient.readContract({ address: weir.vault, abi: vaultAbi, functionName: "balanceOf", args: [saver.address] });

    await wait(await saverWallet.writeContract({ address: weir.token, abi: stablecoinAbi, functionName: "mint", args: [saver.address, 100_000_000n] }));
    await wait(await saverWallet.writeContract({ address: weir.token, abi: vaultAbi, functionName: "approve", args: [weir.vault, 80_000_000n] }));
    await wait(await saverWallet.writeContract({ address: weir.vault, abi: vaultAbi, functionName: "deposit", args: [80_000_000n, saver.address] }));

    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 600;
    const maxTotal = BigInt(plan.maxTotal);
    const [shareCost, shareNonce, tokenNonce] = await Promise.all([
      node.publicClient.readContract({ address: weir.vault, abi: vaultAbi, functionName: "previewWithdraw", args: [maxTotal] }),
      node.publicClient.readContract({ address: weir.vault, abi: vaultAbi, functionName: "nonces", args: [saver.address] }),
      node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "nonces", args: [saver.address] }),
    ]);
    const permitFor = (address: Address, name: string, value: bigint, nonce: bigint) =>
      saver.signTypedData(
        permitTypedData({
          token: { address, permit: { name, version: "1" } },
          chainId: checkout.chainId,
          owner: saver.address,
          spender: checkout.hub,
          value,
          nonce,
          deadline: BigInt(deadline),
        }),
      );
    const terms = {
      merchant: plan.merchant.payoutAddress,
      asset: plan.asset,
      vault: weir.vault,
      manager: zeroAddress,
      amount: BigInt(plan.amount),
      period: plan.period,
      startAt: 0n,
      maxPerCharge: BigInt(plan.maxPerCharge),
      maxTotal,
      expiresAt: BigInt(now + plan.termSeconds),
      ref: refFromString(plan.id),
    };
    const nonce = randomNonce();
    const domain = hubDomain({ name: checkout.domainName, chainId: checkout.chainId, address: checkout.hub });
    const response = await call<InstallResponse>("/v1/relay/install", {
      body: {
        permit: { token: weir.vault, owner: saver.address, value: shareCost.toString(), deadline, signature: await permitFor(weir.vault, "Test AUSD Savings", shareCost, shareNonce) },
        backupPermit: { token: weir.token, owner: saver.address, value: maxTotal.toString(), deadline, signature: await permitFor(weir.token, "Test AUSD", maxTotal, tokenNonce) },
        payer: saver.address,
        terms: { ...terms, amount: terms.amount.toString(), startAt: 0, maxPerCharge: terms.maxPerCharge.toString(), maxTotal: maxTotal.toString(), expiresAt: Number(terms.expiresAt) },
        nonce: nonce.toString(),
        deadline,
        signature: await saver.signTypedData(createMandateTypedData({ domain, payer: saver.address, terms, nonce, deadline: BigInt(deadline) })),
      },
    });
    expect(response.status).toBe(200);
    const id = BigInt(response.body.mandateId);
    // One transaction carried both permits and the mandate.
    expect(response.body.transactions.permit).toBe(response.body.transactions.create);
    expect(await node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "allowance", args: [saver.address, weir.hub] })).toBe(maxTotal);

    // The savings run out: every share goes elsewhere. The balance still holds $20.
    await wait(await saverWallet.writeContract({ address: weir.vault, abi: vaultAbi, functionName: "transfer", args: [anvilAccount(6).address, await shares()] }));
    const [walletBefore, merchantBefore] = await Promise.all([tokenBalance(saver.address), tokenBalance(merchant)]);

    const keeper = createWalletClient({ account: anvilAccount(2), chain: anvil, transport: http(node.rpcUrl) });
    const receipt = await wait(await keeper.writeContract({ address: weir.hub, abi: mandateHubAbi, functionName: "charge", args: [id] }));

    const amount = BigInt(plan.amount);
    expect(await tokenBalance(merchant)).toBe(merchantBefore + amount);
    expect(await tokenBalance(saver.address)).toBe(walletBefore - amount);
    expect(await shares()).toBe(0n);
    const events = parseEventLogs({ abi: mandateHubAbi, logs: receipt.logs }).map((log) => log.eventName);
    expect(events).toEqual(expect.arrayContaining(["ChargedFromBalance", "Charged"]));
    expect(events).not.toContain("ChargeFailed");
  });

  it("sends a one-off payment in the same transaction as its install, so it arrives at once", async () => {
    // A sender of its own who never holds gas, sending $10 once to someone far away.
    const sender = privateKeyToAccount(generatePrivateKey());
    const home = privateKeyToAccount(generatePrivateKey()).address;
    const funder = createWalletClient({ account: anvilAccount(7), chain: anvil, transport: http(node.rpcUrl) });
    const tokenBalance = (who: Address) =>
      node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "balanceOf", args: [who] });
    await node.publicClient.waitForTransactionReceipt({
      hash: await funder.writeContract({ address: weir.token, abi: stablecoinAbi, functionName: "mint", args: [sender.address, 25_000_000n] }),
    });

    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 600;
    const amount = 10_000_000n;
    const domain = hubDomain({ name: checkout.domainName, chainId: checkout.chainId, address: checkout.hub });
    const permitNonce = await node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "nonces", args: [sender.address] });
    const terms = {
      merchant: home,
      asset: weir.token,
      vault: zeroAddress,
      manager: zeroAddress,
      amount,
      period: 2_592_000,
      startAt: 0n,
      maxPerCharge: amount,
      maxTotal: amount,
      expiresAt: BigInt(now + 7 * 86_400),
      ref: refFromString("send-now"),
    };
    const nonce = randomNonce();
    const response = await call<InstallResponse>("/v1/relay/install", {
      body: {
        permit: {
          token: weir.token,
          owner: sender.address,
          value: amount.toString(),
          deadline,
          signature: await sender.signTypedData(
            permitTypedData({
              token: { address: weir.token, permit: { name: "Test AUSD", version: "1" } },
              chainId: checkout.chainId,
              owner: sender.address,
              spender: checkout.hub,
              value: amount,
              nonce: permitNonce,
              deadline: BigInt(deadline),
            }),
          ),
        },
        payer: sender.address,
        terms: { ...terms, amount: amount.toString(), startAt: 0, maxPerCharge: amount.toString(), maxTotal: amount.toString(), expiresAt: Number(terms.expiresAt) },
        nonce: nonce.toString(),
        deadline,
        signature: await sender.signTypedData(createMandateTypedData({ domain, payer: sender.address, terms, nonce, deadline: BigInt(deadline) })),
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.charged).toBe(true);
    // Permit, mandate and charge went in one transaction, and the money is already there.
    expect(response.body.transactions.permit).toBe(response.body.transactions.create);
    expect(await tokenBalance(home)).toBe(amount);
    expect(await tokenBalance(sender.address)).toBe(15_000_000n);
    expect(await node.publicClient.getBalance({ address: sender.address })).toBe(0n);
    const receipt = await node.publicClient.getTransactionReceipt({ hash: response.body.transactions.create });
    const events = parseEventLogs({ abi: mandateHubAbi, logs: receipt.logs }).map((log) => log.eventName);
    expect(events).toEqual(expect.arrayContaining(["MandateCreated", "Charged"]));
    const mandate = await node.publicClient.readContract({ address: weir.hub, abi: mandateHubAbi, functionName: "getMandate", args: [BigInt(response.body.mandateId)] });
    expect(mandate.totalCharged).toBe(amount);
  });

  it("pays a business's earnings out from its own wallet, the relayer paying the fee", async () => {
    const bank = privateKeyToAccount(generatePrivateKey()).address;
    const relayer = anvilAccount(1).address;
    const balance = (who: Address) => node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "balanceOf", args: [who] });
    const earned = await balance(merchant);
    expect(earned).toBeGreaterThanOrEqual(3_000_000n);
    const amount = 3_000_000n;
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const nonce = await node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "nonces", args: [merchant] });
    const signature = await merchantWallet.signTypedData(
      permitTypedData({
        token: { address: weir.token, permit: { name: "Test AUSD", version: "1" } },
        chainId: anvil.id,
        owner: merchant,
        spender: relayer,
        value: amount,
        nonce,
        deadline: BigInt(deadline),
      }),
    );
    const body = { owner: merchant, asset: weir.token, amount: amount.toString(), to: bank, deadline, signature };

    // Only a wallet the signed-in business has proven it holds may pay out.
    expect((await call("/v1/merchant/payout", { body: { ...body, owner: payer.address }, headers: dev })).status).toBe(400);
    expect((await call("/v1/merchant/payout", { body: { ...body, asset: weir.vault }, headers: dev })).status).toBe(400);

    const response = await call<PayoutResponse>("/v1/merchant/payout", { body, headers: dev });
    expect(response.status).toBe(200);
    expect(response.body.spender).toBe(relayer);
    expect(response.body.permit).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await balance(bank)).toBe(amount);
    expect(await balance(merchant)).toBe(earned - amount);
    expect(await node.publicClient.getBalance({ address: merchant })).toBe(0n);
    // The permit was for exactly this payout: nothing is left for the relayer to move.
    expect(await node.publicClient.readContract({ address: weir.token, abi: stablecoinAbi, functionName: "allowance", args: [merchant, relayer] })).toBe(0n);
    // The same signed payout again moves nothing more.
    expect((await call("/v1/merchant/payout", { body, headers: dev })).status).not.toBe(200);
    expect(await balance(bank)).toBe(amount);
  });
});
