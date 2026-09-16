/**
 * Reads straight from Monad, for what must be current to the block: balances, allowances, permit
 * nonces and domains, vault share prices, and a mandate's live state. Everything historical comes
 * from the API's index instead.
 *
 * Concurrent reads are batched into one Multicall3 call, since each round trip to a Monad RPC
 * costs hundreds of milliseconds from far away.
 */

import { MAINNET_AUSD, MAINNET_USDC, TESTNET_USDC, mandateHubAbi, mandateStatusFromIndex, networkFor, stablecoinAbi, type MandateRecord, type MonadChainId, type PermitDomain } from "@weir/shared";
import { createPublicClient, domainSeparator, http, parseAbi, type Address, type PublicClient, type TypedDataDomain } from "viem";

import { messageOf, WeirError } from "./errors.js";

export interface ChainReader {
  readonly chainId: MonadChainId;
  balanceOf(token: Address, owner: Address): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  permitNonce(token: Address, owner: Address): Promise<bigint>;
  /** The EIP-712 domain the token's `permit` signs under, besides the chain and the token. */
  permitDomain(token: Address): Promise<PermitDomain>;
  /** Shares the vault would burn to pay out `assets` today. */
  previewWithdraw(vault: Address, assets: bigint): Promise<bigint>;
  /** What `owner`'s shares in `vault` would pay out if redeemed now. */
  vaultValue(vault: Address, owner: Address): Promise<bigint>;
  /** The mandate as the hub holds it, or `undefined` when no mandate has that id. */
  mandate(hub: Address, mandateId: bigint): Promise<MandateRecord | undefined>;
  /** The hub's own EIP-712 domain, read with ERC-5267. */
  hubDomain(hub: Address): Promise<TypedDataDomain>;
}

export const vaultAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
]);

const domainAbi = parseAbi([
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

/**
 * The known stablecoins' permit domains. They do not implement ERC-5267, and AUSD's domain name is
 * "Agora Dollar", not its `name()`, so these are recorded rather than read.
 */
const KNOWN_DOMAINS: Readonly<Record<string, PermitDomain>> = Object.fromEntries(
  [MAINNET_USDC, MAINNET_AUSD, TESTNET_USDC].map((asset) => [asset.address.toLowerCase(), asset.permit]),
);

/** ERC-5267's field bits. */
const NAME = 0x01;
const VERSION = 0x02;
const CHAIN_AND_CONTRACT = 0x04 | 0x08;
const SALT = 0x10;

/**
 * The permit domain an ERC-5267 answer declares, refusing a salted domain or one without the chain
 * and the contract, which no Weir asset uses and a guess would only turn into a failed relay.
 */
export function domainFromDeclared(token: Address, declared: { fields: number; name: string; version: string }): PermitDomain {
  if ((declared.fields & SALT) !== 0 || (declared.fields & CHAIN_AND_CONTRACT) !== CHAIN_AND_CONTRACT) {
    throw new WeirError("PERMIT_DOMAIN_UNKNOWN", `${token} signs permits under a domain Weir does not support`, "Pick a plan in USDC or AUSD.");
  }
  return {
    ...((declared.fields & NAME) !== 0 ? { name: declared.name } : {}),
    ...((declared.fields & VERSION) !== 0 ? { version: declared.version } : {}),
  };
}

export function knownPermitDomain(token: Address): PermitDomain | undefined {
  return KNOWN_DOMAINS[token.toLowerCase()];
}

export function createChainReader(chainId: MonadChainId, rpcUrl?: string): ChainReader {
  const network = networkFor(chainId);
  const client: PublicClient = createPublicClient({
    chain: network.chain,
    transport: http(rpcUrl),
    batch: { multicall: true },
  });
  const endpoint = rpcUrl ?? network.chain.rpcUrls.default.http[0] ?? "the public RPC";

  const read = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof WeirError) throw cause;
      throw new WeirError(
        "RPC_FAILED",
        `Could not read ${what} from ${network.label} through ${endpoint}: ${firstLine(messageOf(cause))}`,
        "Try again. Set MONAD_RPC_URL to use another endpoint.",
      );
    }
  };

  const domainCache = new Map<string, Promise<PermitDomain>>();

  async function readPermitDomain(token: Address): Promise<PermitDomain> {
    const declared = await client
      .readContract({ address: token, abi: domainAbi, functionName: "eip712Domain" })
      .then(([fields, name, version]) => ({ fields: Number(fields), name, version }))
      .catch(() => undefined);
    if (declared !== undefined) return domainFromDeclared(token, declared);

    const separator = await client.readContract({ address: token, abi: domainAbi, functionName: "DOMAIN_SEPARATOR" });
    if (separator === domainSeparator({ domain: { chainId, verifyingContract: token } })) return {};
    throw new WeirError("PERMIT_DOMAIN_UNKNOWN", `Could not tell how ${token} signs permits`, "Pick a plan in USDC or AUSD.");
  }

  return {
    chainId,
    balanceOf: (token, owner) =>
      read(`the balance of ${owner}`, () => client.readContract({ address: token, abi: stablecoinAbi, functionName: "balanceOf", args: [owner] })),
    allowance: (token, owner, spender) =>
      read(`the allowance of ${owner}`, () =>
        client.readContract({ address: token, abi: stablecoinAbi, functionName: "allowance", args: [owner, spender] }),
      ),
    permitNonce: (token, owner) =>
      read(`the permit nonce of ${owner}`, () => client.readContract({ address: token, abi: stablecoinAbi, functionName: "nonces", args: [owner] })),
    permitDomain: (token) => {
      const known = knownPermitDomain(token);
      if (known !== undefined) return Promise.resolve(known);
      const key = token.toLowerCase();
      let domain = domainCache.get(key);
      if (domain === undefined) {
        domain = read(`the permit domain of ${token}`, () => readPermitDomain(token));
        domain.catch(() => domainCache.delete(key));
        domainCache.set(key, domain);
      }
      return domain;
    },
    previewWithdraw: (vault, assets) =>
      read(`the share price of ${vault}`, () => client.readContract({ address: vault, abi: vaultAbi, functionName: "previewWithdraw", args: [assets] })),
    vaultValue: (vault, owner) =>
      read(`the savings of ${owner}`, async () => {
        const shares = await client.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [owner] });
        if (shares === 0n) return 0n;
        return client.readContract({ address: vault, abi: vaultAbi, functionName: "previewRedeem", args: [shares] });
      }),
    mandate: (hub, mandateId) =>
      read(`mandate #${mandateId}`, async () => {
        const stored = await client.readContract({ address: hub, abi: mandateHubAbi, functionName: "getMandate", args: [mandateId] });
        if (stored.payer === "0x0000000000000000000000000000000000000000") return undefined;
        return {
          id: mandateId,
          payer: stored.payer,
          merchant: stored.merchant,
          asset: stored.asset,
          vault: stored.vault,
          manager: stored.manager,
          amount: stored.amount,
          period: Number(stored.period),
          nextChargeAt: stored.nextChargeAt,
          maxPerCharge: stored.maxPerCharge,
          maxTotal: stored.maxTotal,
          totalCharged: stored.totalCharged,
          expiresAt: stored.expiresAt,
          pausedAt: stored.pausedAt,
          status: mandateStatusFromIndex(Number(stored.status)),
        };
      }),
    hubDomain: (hub) =>
      read(`the hub's signing domain`, async () => {
        const [, name, version, domainChainId, verifyingContract] = await client.readContract({
          address: hub,
          abi: domainAbi,
          functionName: "eip712Domain",
        });
        return { name, version, chainId: Number(domainChainId), verifyingContract };
      }),
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? text;
}
