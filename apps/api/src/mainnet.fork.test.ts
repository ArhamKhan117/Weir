/**
 * Weir on Monad Mainnet, end to end on a fork of it: real USDC, the real Morpho vault over it and
 * the real Chainlink forwarders, with this repository's hub, charger and router deployed onto the
 * fork beside them, driven through this API's relayer exactly as the web app drives it. With
 * `WEIR_FORK_RECORDED=1` it uses the contracts the Mainnet record names instead, to check what is
 * deployed. No real money moves: the fork is a local node, and the payer's dollars are written into
 * its copy of USDC.
 *
 * A fresh payer that never holds MON saves through the router, installs a mandate on its balance
 * and one on its savings (with the backup permit), is charged for both through `MandateCharger`,
 * runs its savings out so the next charge falls back to the balance, and pauses a stream with its
 * session key alone.
 *
 * It reads Mainnet over the network, so it runs only when asked:
 *
 *   WEIR_FORK_E2E=1 pnpm exec vitest run apps/api/src/mainnet.fork.test.ts
 */

import type { AddressInfo } from "node:net";

import { serve, type ServerType } from "@hono/node-server";
import {
  actionTypedData,
  createMandateTypedData,
  hubDomain,
  MAINNET_USDC,
  mandateChargerAbi,
  mandateHubAbi,
  permitTypedData,
  randomNonce,
  refFromString,
  requireDeployment,
  stablecoinAbi,
  type InstallResponse,
  type MandateTerms,
  type RelayResponse,
  VAULT_ACCRUAL_GAS,
} from "@weir/shared";
import {
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  numberToHex,
  parseAbi,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { silentLogger } from "./log.js";
import { monadNetwork } from "./network.js";
import { createApiService, type ApiService } from "./service.js";
import { anvilAccount, anvilAvailable, deployWeirOnFork, startAnvil, type AnvilNode } from "./test/anvil.js";
import { openTestDatabase, type TestDatabase } from "./test/db.js";

const MAINNET = 143;
const enabled = process.env.WEIR_FORK_E2E === "1" && anvilAvailable();
const db: TestDatabase | undefined = enabled ? await openTestDatabase("fork") : undefined;

const DOLLAR = 1_000_000n;
const MONTH = 2_592_000;

const vaultAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
]);

describe.skipIf(!enabled || db === undefined)("Weir on a fork of Monad Mainnet", () => {
  const record = requireDeployment(MAINNET);
  const usdc = record.assets["USDC"] as Address;
  const vault = record.savings?.["USDC"] as Address;
  // The contracts under test: deployed onto the fork in `beforeAll`, or the recorded ones.
  let hub: Address = record.contracts.MandateHub;
  let charger: Address = record.contracts.MandateCharger;
  let router: Address = record.contracts.SavingsRouter as Address;

  const payer = privateKeyToAccount(generatePrivateKey());
  const session = privateKeyToAccount(generatePrivateKey());
  const merchant = privateKeyToAccount(generatePrivateKey()).address;

  let node: AnvilNode;
  let service: ApiService;
  let server: ServerType;
  let base: string;

  /** POSTs `body`; a relay that was mined and reverted comes back with its trace's innermost error. */
  const call = async <T>(path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const parsed = (await response.json()) as T & { error?: { message?: string } };
    const mined = /transaction (0x[0-9a-f]{64})/.exec(parsed.error?.message ?? "")?.[1];
    if (mined !== undefined) Object.assign(parsed, { trace: await innermostError(mined as Hex) });
    return { status: response.status, body: parsed as T };
  };

  interface Frame {
    to?: string;
    error?: string;
    revertReason?: string;
    gas?: string;
    gasUsed?: string;
    calls?: Frame[];
  }
  /** The deepest failing frame of a mined transaction, from Anvil's call tracer. */
  async function innermostError(hash: Hex): Promise<string> {
    const trace = (await node.publicClient.request({
      method: "debug_traceTransaction" as never,
      params: [hash, { tracer: "callTracer" }] as never,
    })) as Frame;
    let frame = trace;
    for (;;) {
      const failing = frame.calls?.find((child) => child.error !== undefined);
      if (failing === undefined) break;
      frame = failing;
    }
    return `${frame.to}: ${frame.error}${frame.revertReason === undefined ? "" : ` (${frame.revertReason})`}, gas ${frame.gasUsed}/${frame.gas}`;
  }
  const usdcOf = (who: Address) => node.publicClient.readContract({ address: usdc, abi: stablecoinAbi, functionName: "balanceOf", args: [who] });
  const sharesOf = (who: Address) => node.publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [who] });
  const now = async () => Number((await node.publicClient.getBlock()).timestamp);

  /** Writes `amount` into `who`'s USDC balance on the fork, finding the balance mapping's slot. */
  async function deal(who: Address, amount: bigint): Promise<void> {
    for (let slot = 0n; slot < 64n; slot += 1n) {
      const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, slot]));
      const before = await node.publicClient.getStorageAt({ address: usdc, slot: key });
      await node.publicClient.request({ method: "anvil_setStorageAt" as never, params: [usdc, key, numberToHex(amount, { size: 32 })] as never });
      if ((await usdcOf(who)) === amount) return;
      await node.publicClient.request({ method: "anvil_setStorageAt" as never, params: [usdc, key, before ?? numberToHex(0, { size: 32 })] as never });
    }
    throw new Error("no balance slot found for USDC");
  }

  async function advance(seconds: number): Promise<void> {
    await node.publicClient.request({ method: "evm_increaseTime" as never, params: [numberToHex(seconds)] as never });
    await node.publicClient.request({ method: "evm_mine" as never, params: [] as never });
  }

  /** A permit `payer` signs for `spender` on `token`, under the token's own domain. */
  async function permit(token: Address, domain: { name?: string; version?: string }, spender: Address, value: bigint, deadline: number): Promise<Hex> {
    const nonce = await node.publicClient.readContract({ address: token, abi: vaultAbi, functionName: "nonces", args: [payer.address] });
    return payer.signTypedData(
      permitTypedData({ token: { address: token, permit: domain }, chainId: MAINNET, owner: payer.address, spender, value, nonce, deadline: BigInt(deadline) }),
    );
  }

  /** Installs `terms` through the relayer: the permit on what it draws, the backup when from savings, then the terms. */
  async function install(terms: MandateTerms): Promise<{ id: bigint; response: InstallResponse }> {
    const deadline = (await now()) + 600;
    const fromSavings = terms.vault !== zeroAddress;
    const shares = fromSavings
      ? await node.publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "previewWithdraw", args: [terms.maxTotal] })
      : terms.maxTotal;
    const permitBody = fromSavings
      ? { token: vault, owner: payer.address, value: shares.toString(), deadline, signature: await permit(vault, {}, hub, shares, deadline) }
      : { token: usdc, owner: payer.address, value: terms.maxTotal.toString(), deadline, signature: await permit(usdc, MAINNET_USDC.permit, hub, terms.maxTotal, deadline) };
    // One allowance serves every mandate on the asset, so the backup adds this cap to what is already allowed.
    const allowed = await node.publicClient.readContract({ address: usdc, abi: stablecoinAbi, functionName: "allowance", args: [payer.address, hub] });
    const backupValue = allowed + terms.maxTotal;
    const backupBody = fromSavings
      ? { token: usdc, owner: payer.address, value: backupValue.toString(), deadline, signature: await permit(usdc, MAINNET_USDC.permit, hub, backupValue, deadline) }
      : undefined;
    const nonce = randomNonce();
    const domain = hubDomain({ name: record.eip712.name, chainId: MAINNET, address: hub });
    const response = await call<InstallResponse>("/v1/relay/install", {
      permit: permitBody,
      ...(backupBody === undefined ? {} : { backupPermit: backupBody }),
      payer: payer.address,
      terms: {
        ...terms,
        amount: terms.amount.toString(),
        startAt: Number(terms.startAt),
        maxPerCharge: terms.maxPerCharge.toString(),
        maxTotal: terms.maxTotal.toString(),
        expiresAt: Number(terms.expiresAt),
      },
      nonce: nonce.toString(),
      deadline,
      signature: await payer.signTypedData(createMandateTypedData({ domain, payer: payer.address, terms, nonce, deadline: BigInt(deadline) })),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { id: BigInt(response.body.mandateId), response: response.body };
  }

  async function terms(overrides: Partial<MandateTerms>): Promise<MandateTerms> {
    return {
      merchant,
      asset: usdc,
      vault: zeroAddress,
      manager: session.address,
      amount: 2n * DOLLAR,
      period: MONTH,
      startAt: 0n,
      maxPerCharge: 2n * DOLLAR,
      maxTotal: 24n * DOLLAR,
      expiresAt: BigInt((await now()) + 365 * 86_400),
      ref: refFromString("fork"),
      ...overrides,
    };
  }

  const keeper = () => createWalletClient({ account: anvilAccount(2), chain: monadNetwork({ chainId: MAINNET, rpcUrl: node.rpcUrl }).chain, transport: http(node.rpcUrl) });
  /**
   * Charges `ids` through the charger as the keeper does: the node's estimate, plus one interest
   * accrual for each of the `vaults` distinct savings vaults they draw on, plus the keeper's 5% and
   * 5,000.
   * Returns the hub's events; a charge the charger caught reverting fails the test with its reason.
   */
  async function chargeMany(ids: bigint[], vaults: number) {
    const client = keeper();
    const estimate = await node.publicClient.estimateContractGas({ account: client.account, address: charger, abi: mandateChargerAbi, functionName: "chargeMany", args: [ids] });
    const accrued = estimate + VAULT_ACCRUAL_GAS * BigInt(vaults);
    const gas = (accrued * 10_500n + 9_999n) / 10_000n + 5_000n;
    const hash = await client.writeContract({ address: charger, abi: mandateChargerAbi, functionName: "chargeMany", args: [ids], gas });
    const receipt = await node.publicClient.waitForTransactionReceipt({ hash });
    const reverted = parseEventLogs({ abi: mandateChargerAbi, logs: receipt.logs, eventName: "ChargeReverted" });
    const tx = await node.publicClient.getTransaction({ hash });
    expect(
      reverted.map((log) => `${log.args.mandateId}: ${log.args.reason}`),
      `charges the charger caught reverting, with a limit of ${tx.gas} and ${receipt.gasUsed} used`,
    ).toEqual([]);
    return parseEventLogs({ abi: mandateHubAbi, logs: receipt.logs }).filter((log) => log.address.toLowerCase() === hub.toLowerCase());
  }

  beforeAll(async () => {
    node = await startAnvil({ forkUrl: process.env.WEIR_FORK_URL ?? "https://rpc.monad.xyz" });
    const network = monadNetwork({ chainId: MAINNET, rpcUrl: node.rpcUrl });
    if (process.env.WEIR_FORK_RECORDED !== "1") {
      const fresh = await deployWeirOnFork(node, network.chain, record);
      network.deployment = fresh.deployment;
      hub = fresh.deployment.hub;
      charger = fresh.charger;
      router = fresh.deployment.router as Address;
    }
    service = createApiService({
      network,
      sql: db!.sql,
      publicClient: node.publicClient,
      logger: silentLogger,
      relayerAccount: anvilAccount(1),
      devAuth: false,
      faucetAmount: 0n,
      allowedOrigins: [],
      indexer: false,
    });
    service.start();
    server = serve({ fetch: service.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await deal(payer.address, 100n * DOLLAR);
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
    await service?.stop();
    await node?.stop();
    await db?.close();
  });

  let fromBalance: bigint;
  let fromSavings: bigint;

  it("saves into the Morpho USDC vault through the router, on a permit, with no gas from the payer", async () => {
    const deadline = (await now()) + 600;
    const amount = 40n * DOLLAR;
    const before = await usdcOf(payer.address);
    const response = await call<RelayResponse>("/v1/relay/savings", {
      direction: "deposit",
      owner: payer.address,
      asset: usdc,
      amount: amount.toString(),
      deadline,
      signature: await permit(usdc, MAINNET_USDC.permit, router, amount, deadline),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await usdcOf(payer.address)).toBe(before - amount);
    const saved = await node.publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "previewRedeem", args: [await sharesOf(payer.address)] });
    // The vault rounds in its own favour by at most a base unit.
    expect(saved).toBeGreaterThanOrEqual(amount - 1n);
    expect(await node.publicClient.getBalance({ address: payer.address })).toBe(0n);
  }, 120_000);

  it("installs a mandate on the balance and one on savings with its backup, each in one relayed transaction", async () => {
    fromBalance = (await install(await terms({}))).id;
    const savings = await install(await terms({ vault, ref: refFromString("fork-savings") }));
    fromSavings = savings.id;
    // The vault permit, the backup permit and the mandate went in one transaction.
    expect(savings.response.transactions.permit).toBe(savings.response.transactions.create);
    expect(await node.publicClient.readContract({ address: usdc, abi: stablecoinAbi, functionName: "allowance", args: [payer.address, hub] })).toBe(48n * DOLLAR);
  }, 120_000);

  it("charges both through MandateCharger: the balance from the wallet, the savings from the real vault", async () => {
    const [walletBefore, sharesBefore, merchantBefore] = await Promise.all([usdcOf(payer.address), sharesOf(payer.address), usdcOf(merchant)]);
    const events = await chargeMany([fromBalance, fromSavings], 1);

    expect(events.filter((e) => e.eventName === "Charged")).toHaveLength(2);
    expect(events.some((e) => e.eventName === "ChargedFromBalance" || e.eventName === "ChargeFailed")).toBe(false);
    expect(await usdcOf(merchant)).toBe(merchantBefore + 4n * DOLLAR);
    // The direct mandate came from the wallet; the savings mandate from shares, not the wallet.
    expect(await usdcOf(payer.address)).toBe(walletBefore - 2n * DOLLAR);
    expect(await sharesOf(payer.address)).toBeLessThan(sharesBefore);
  }, 180_000);

  it("pays the savings mandate from the balance once the savings run out", async () => {
    // Everything saved goes back to the balance, on a permit to the router for the shares it burns.
    const deadline = (await now()) + 600;
    const shares = await sharesOf(payer.address);
    const assets = await node.publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "previewRedeem", args: [shares] });
    const withdrawn = assets - 1n;
    const maxShares = await node.publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "previewWithdraw", args: [withdrawn] });
    const out = await call<RelayResponse>("/v1/relay/savings", {
      direction: "withdraw",
      owner: payer.address,
      asset: usdc,
      amount: withdrawn.toString(),
      maxShares: maxShares.toString(),
      deadline,
      signature: await permit(vault, {}, router, maxShares, deadline),
    });
    expect(out.status, JSON.stringify(out.body)).toBe(200);

    await advance(MONTH);
    const [walletBefore, sharesBefore, merchantBefore] = await Promise.all([usdcOf(payer.address), sharesOf(payer.address), usdcOf(merchant)]);
    const events = await chargeMany([fromSavings], 1);

    expect(events.map((e) => e.eventName)).toEqual(expect.arrayContaining(["ChargedFromBalance", "Charged"]));
    expect(await usdcOf(merchant)).toBe(merchantBefore + 2n * DOLLAR);
    expect(await usdcOf(payer.address)).toBe(walletBefore - 2n * DOLLAR);
    expect(await sharesOf(payer.address)).toBe(sharesBefore);
  }, 180_000);

  it("streams from the balance and pauses on the session key's signature alone, settling the time used", async () => {
    const { id } = await install(await terms({ period: 0, amount: 100n, maxPerCharge: 5n * DOLLAR, maxTotal: 5n * DOLLAR, ref: refFromString("fork-stream") }));
    await advance(600);

    const nonce = randomNonce();
    const deadline = (await now()) + 600;
    const merchantBefore = await usdcOf(merchant);
    const paused = await call<RelayResponse>("/v1/relay/action", {
      mandateId: id.toString(),
      action: "pause",
      signer: session.address,
      nonce: nonce.toString(),
      deadline,
      signature: await session.signTypedData(
        actionTypedData({ domain: hubDomain({ name: record.eip712.name, chainId: MAINNET, address: hub }), mandateId: id, action: "pause", nonce, deadline: BigInt(deadline) }),
      ),
    });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    const mandate = await node.publicClient.readContract({ address: hub, abi: mandateHubAbi, functionName: "getMandate", args: [id] });
    expect(mandate.pausedAt).toBeGreaterThan(0n);
    // At least the ten minutes advanced, at a hundred base units a second.
    expect((await usdcOf(merchant)) - merchantBefore).toBeGreaterThanOrEqual(60_000n);
    expect(await node.publicClient.getBalance({ address: payer.address })).toBe(0n);
  }, 180_000);

  it("sends real USDC once, arriving in the same transaction as its install", async () => {
    const home = privateKeyToAccount(generatePrivateKey()).address;
    const amount = 3n * DOLLAR;
    const walletBefore = await usdcOf(payer.address);
    const { response } = await install(await terms({ merchant: home, amount, maxPerCharge: amount, maxTotal: amount, ref: refFromString("fork-send-now") }));
    expect(response.charged).toBe(true);
    expect(await usdcOf(home)).toBe(amount);
    expect(await usdcOf(payer.address)).toBe(walletBefore - amount);
    expect(await node.publicClient.getBalance({ address: payer.address })).toBe(0n);
  }, 180_000);
});
