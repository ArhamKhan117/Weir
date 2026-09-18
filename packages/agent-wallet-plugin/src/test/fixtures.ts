/**
 * Fakes for the plugin's tests: a checkout answer, an API that serves it, a chain reader with
 * fixed answers, and a host context whose wallet executor signs with a viem local account after
 * putting the typed data through the same JSON encoding the host uses on the wire.
 */

import type { CheckoutResponse, MandateRecord, MonadChainId, PayerResponse, PermitDomain, Plan, SavingsResponse } from "@weir/shared";
import type { Address, Hex, LocalAccount, TypedDataDomain } from "viem";

import type { HealthInfo, WeirApi } from "../core/api.js";
import type { ChainReader } from "../core/chain.js";
import type { Deps } from "../core/deps.js";
import type { Settings } from "../core/settings.js";
import type { ExecutorLike, HostContextLike, TypedDataJob } from "../host.js";

export const HUB: Address = "0x6CfD37e32c51d87c20362EeD0C6cc8908855045D";
export const ASSET: Address = "0xf3066908dABe11f2e72F6887D9943eeb621a0Eb9";
export const VAULT: Address = "0xe0cd535d298DAd5e228486a79A21176349825B8d";
export const ROUTER: Address = "0x41dC6AE1e9939ACFd73d64e114Ee48711AB4A46E";
export const MERCHANT: Address = "0x1e58Ae7a5bFb164ff071Dd5e71a1061A0E9097a1";
export const NOW = 1_790_000_000;

export const plan: Plan = {
  id: "pln_5xjqdh77j4gflgvy",
  merchant: { id: "mer_4zq2zhxunt2pj4wh", name: "Lumen Studio", payoutAddress: MERCHANT },
  name: "Studio Pro",
  description: "Unlimited projects, 4K exports and priority support",
  asset: ASSET,
  assetSymbol: "tAUSD",
  mode: "periodic",
  amount: "9990000",
  period: 2_592_000,
  trialDays: 0,
  maxPerCharge: "9990000",
  maxTotal: "119880000",
  termSeconds: 31_104_000,
  active: true,
  createdAt: 1_789_000_000,
};

export function checkoutFor(overrides: Partial<Plan> = {}, extra: Partial<CheckoutResponse> = {}): CheckoutResponse {
  return {
    plan: { ...plan, ...overrides },
    chainId: 10143,
    hub: HUB,
    domainName: "Weir",
    savingsVault: { address: VAULT, name: "Test AUSD Savings", symbol: "stAUSD", apyBps: 500 },
    ...extra,
  };
}

export interface FakeChain {
  balance: bigint;
  saved: bigint;
  allowance: bigint;
  permitNonce: bigint;
  /** Shares per asset unit, as a ratio, for `previewWithdraw`. */
  sharesPerUnit: { numerator: bigint; denominator: bigint };
  permitDomains: Record<string, PermitDomain>;
  mandates: Map<bigint, MandateRecord>;
}

export function fakeChain(chainId: MonadChainId, state: Partial<FakeChain> = {}): ChainReader & { state: FakeChain } {
  const full: FakeChain = {
    balance: 50_000_000n,
    saved: 0n,
    allowance: 0n,
    permitNonce: 0n,
    sharesPerUnit: { numerator: 1n, denominator: 1n },
    permitDomains: { [ASSET.toLowerCase()]: { name: "Test AUSD", version: "1" }, [VAULT.toLowerCase()]: { name: "Test AUSD Savings", version: "1" } },
    mandates: new Map(),
    ...state,
  };
  const domain: TypedDataDomain = { name: "Weir", version: "1", chainId, verifyingContract: HUB };
  return {
    state: full,
    chainId,
    balanceOf: async () => full.balance,
    allowance: async () => full.allowance,
    permitNonce: async () => full.permitNonce,
    permitDomain: async (token) => {
      const found = full.permitDomains[token.toLowerCase()];
      if (found === undefined) throw new Error(`no permit domain for ${token}`);
      return found;
    },
    previewWithdraw: async (_vault, assets) => (assets * full.sharesPerUnit.numerator + full.sharesPerUnit.denominator - 1n) / full.sharesPerUnit.denominator,
    vaultValue: async () => full.saved,
    mandate: async (_hub, id) => full.mandates.get(id),
    hubDomain: async () => domain,
  };
}

export interface FakeApiCalls {
  install: unknown[];
  action: unknown[];
  savings: unknown[];
}

export function fakeApi(options: {
  checkout?: CheckoutResponse;
  health?: HealthInfo;
  payer?: PayerResponse;
  savings?: SavingsResponse;
}): WeirApi & { calls: FakeApiCalls } {
  const calls: FakeApiCalls = { install: [], action: [], savings: [] };
  const tx = `0x${"ab".repeat(32)}` as Hex;
  return {
    calls,
    baseUrl: "http://localhost:8790",
    checkout: async () => options.checkout ?? checkoutFor(),
    health: async () => options.health ?? { chainId: 10143, hub: HUB },
    payer: async () => options.payer ?? { mandates: [], charges: [] },
    savingsVaults: async () =>
      options.savings ?? {
        router: ROUTER,
        vaults: [{ asset: ASSET, assetSymbol: "tAUSD", address: VAULT, name: "Test AUSD Savings", symbol: "stAUSD", apyBps: 500 }],
      },
    install: async (body) => {
      calls.install.push(body);
      return { mandateId: "42", transactions: { create: tx } };
    },
    action: async (body) => {
      calls.action.push(body);
      return { transaction: tx };
    },
    savings: async (body) => {
      calls.savings.push(body);
      return { transaction: tx };
    },
    faucet: async () => ({ transaction: tx, amount: "100000000", asset: ASSET }),
  };
}

export function fakeDeps(parts: { api?: WeirApi; chain?: ChainReader; settings?: Partial<Settings>; now?: number } = {}): Deps {
  const chain = parts.chain ?? fakeChain(10143);
  return {
    settings: { apiUrl: "http://localhost:8790", ...parts.settings },
    api: parts.api ?? fakeApi({}),
    chain: () => chain,
    now: () => parts.now ?? NOW,
    timeZone: "UTC",
  };
}

export function periodicMandate(overrides: Partial<MandateRecord> = {}): MandateRecord {
  return {
    id: 3n,
    payer: "0x4e80fA4AD069245b976ad4FD4Ff1d8f94965aF8C",
    merchant: MERCHANT,
    asset: ASSET,
    vault: "0x0000000000000000000000000000000000000000",
    manager: "0x37Ccf5613cFAD47ddC07C3A86Dc5f29865423176",
    amount: 9_990_000n,
    period: 2_592_000,
    nextChargeAt: BigInt(NOW + 86_400),
    maxPerCharge: 9_990_000n,
    maxTotal: 119_880_000n,
    totalCharged: 9_990_000n,
    expiresAt: BigInt(NOW + 31_104_000),
    pausedAt: 0n,
    status: "Active",
    ...overrides,
  };
}

/**
 * The host's wire encoding for a signing request: `JSON.stringify` with every bigint as `0x` hex,
 * and an `EIP712Domain` type added from whichever domain fields are present, in the canonical order.
 */
export function hostWireEncoding(typedData: unknown): { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> } {
  const withDomain = typedData as { domain?: Record<string, unknown>; types: Record<string, unknown> };
  const order = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt", type: "bytes32" },
  ];
  const domain = withDomain.domain ?? {};
  const full = withDomain.types["EIP712Domain"] === undefined ? { ...withDomain, types: { ...withDomain.types, EIP712Domain: order.filter((field) => domain[field.name] !== undefined) } } : withDomain;
  return JSON.parse(JSON.stringify(full, (_key, value: unknown) => (typeof value === "bigint" ? `0x${value.toString(16)}` : value)));
}

/** Undoes the hex encoding of integer fields, as an EIP-712 signer does when it reads the request. */
export function decodeWire(wire: ReturnType<typeof hostWireEncoding>): { domain: TypedDataDomain; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> } {
  const decode = (type: string, value: unknown): unknown => {
    if (/^u?int\d*$/.test(type)) return typeof value === "string" ? BigInt(value) : BigInt(value as number);
    const struct = wire.types[type];
    if (struct !== undefined && typeof value === "object" && value !== null) {
      return Object.fromEntries(struct.map((field) => [field.name, decode(field.type, (value as Record<string, unknown>)[field.name])]));
    }
    return value;
  };
  const { EIP712Domain: _domainType, ...types } = wire.types;
  void _domainType;
  const domain = { ...wire.domain } as Record<string, unknown>;
  if (domain["chainId"] !== undefined) domain["chainId"] = Number(BigInt(domain["chainId"] as string | number));
  return { domain: domain as TypedDataDomain, types, primaryType: wire.primaryType, message: decode(wire.primaryType, wire.message) as Record<string, unknown> };
}

/**
 * A host context whose wallet executor behaves like the CLI's for typed data: it takes the
 * `typed-data` request, sends it through the host's wire encoding, and answers a signature from
 * `account`, which stands in for the wallet's key.
 */
export function fakeHost(account: LocalAccount, options: { answer?: (job: TypedDataJob) => ReturnType<ExecutorLike> } = {}): HostContextLike & { jobs: TypedDataJob[] } {
  const jobs: TypedDataJob[] = [];
  const executor: ExecutorLike = async (job) => {
    jobs.push(job);
    if (options.answer !== undefined) return options.answer(job);
    const decoded = decodeWire(hostWireEncoding(job.typedData));
    const signature = await account.signTypedData(decoded as Parameters<LocalAccount["signTypedData"]>[0]);
    return { kind: "signature", signature, status: "SIGNED" };
  };
  return {
    jobs,
    walletStateManager: {
      read: () => ({
        remoteWallets: [{ id: "w1", address: account.address.toLowerCase(), namespace: "evm" }],
        selectedWallet: { mode: "server", namespace: "evm", ref: { id: "w1" } },
      }),
    },
    walletExecutor: async () => executor,
  };
}

/** A `CommandIO` stand-in with the members the host bridge reads. */
export const fakeIo = { signal: new AbortController().signal } as unknown as Parameters<NonNullable<HostContextLike["walletExecutor"]>>[0];
