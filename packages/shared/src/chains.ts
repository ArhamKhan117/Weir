/**
 * Monad networks and the assets a mandate can charge on each.
 *
 * Everything here is a fact about the chain, not about this project's deployment: token
 * addresses, their EIP-712 permit domains, Permit2, Multicall3, the Chainlink CRE forwarders
 * and the Envio HyperSync endpoints. What this project deployed lives in `deployments.json`.
 *
 * The permit domains matter more than they look. A permit signed under the wrong domain is
 * rejected with nothing but a bad-signature error, and AUSD's domain name is "Agora Dollar",
 * not its `name()`, which is "AUSD". Each domain below was read from the token itself.
 */

import { type Chain, defineChain } from "viem";
import { monad, monadTestnet as viemMonadTestnet } from "viem/chains";

import type { Address } from "./types.js";

export const MONAD_MAINNET_CHAIN_ID = 143 as const;
export const MONAD_TESTNET_CHAIN_ID = 10143 as const;

export type MonadChainId = typeof MONAD_MAINNET_CHAIN_ID | typeof MONAD_TESTNET_CHAIN_ID;

/** Monad Mainnet, as viem describes it. */
export const monadMainnet: Chain = monad;

/** Monad Testnet, with MonadVision as its explorer to match Mainnet. */
export const monadTestnet: Chain = defineChain({
  ...viemMonadTestnet,
  blockExplorers: { default: { name: "MonadVision", url: "https://testnet.monadvision.com" } },
});

/**
 * The EIP-712 domain a token's `permit` signs under, besides the chain and the token itself. Both
 * are absent for a token whose domain is only `chainId` and `verifyingContract`, as a Morpho
 * vault's is.
 */
export interface PermitDomain {
  readonly name?: string;
  readonly version?: string;
}

/** A token a mandate can be denominated in. */
export interface AssetInfo {
  readonly symbol: string;
  /** What a person reads: "US Dollar Coin", never a ticker alone. */
  readonly label: string;
  readonly address: Address;
  readonly decimals: 6;
  readonly permit: PermitDomain;
  /** True for a Testnet stand-in anyone can mint. */
  readonly test: boolean;
}

export const MAINNET_USDC: AssetInfo = {
  symbol: "USDC",
  label: "USD Coin",
  address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  decimals: 6,
  permit: { name: "USDC", version: "2" },
  test: false,
};

export const MAINNET_AUSD: AssetInfo = {
  symbol: "AUSD",
  label: "Agora Dollar",
  address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
  decimals: 6,
  permit: { name: "Agora Dollar", version: "1" },
  test: false,
};

export const TESTNET_USDC: AssetInfo = {
  symbol: "USDC",
  label: "USD Coin",
  address: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  decimals: 6,
  permit: { name: "USDC", version: "2" },
  test: false,
};

/** Canonical on both networks. */
export const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * Gas to add, once per savings vault, to any transaction that draws on or pays into one, beyond
 * what its estimate shows. A Morpho Vault V2 accrues its interest on the first touch in a block
 * with a newer timestamp, and that costs about 50,000 gas whatever the time since: a USDC
 * withdrawal measured 368,213 gas in the second of the last accrual and 418,073 one second
 * later. An estimate run in the same second as the vault's last touch misses it, and the
 * transaction then runs out of gas; this covers it.
 */
export const VAULT_ACCRUAL_GAS = 60_000n;

/** Chainlink CRE forwarders: the production `KeystoneForwarder` and the simulator's mock. */
export interface CreForwarders {
  readonly chainSelectorName: string;
  readonly forwarder: Address;
  readonly simulationForwarder: Address;
}

export interface NetworkInfo {
  readonly chain: Chain;
  readonly label: string;
  readonly hypersyncUrl: string;
  /** The public RPC answers at most this many blocks per `eth_getLogs`. */
  readonly logChunkBlocks: number;
  readonly cre: CreForwarders;
}

export const NETWORKS: Readonly<Record<MonadChainId, NetworkInfo>> = {
  [MONAD_MAINNET_CHAIN_ID]: {
    chain: monadMainnet,
    label: "Monad",
    hypersyncUrl: "https://monad.hypersync.xyz",
    logChunkBlocks: 100,
    cre: {
      chainSelectorName: "monad-mainnet",
      forwarder: "0x76c9cf548b4179F8901cda1f8623568b58215E62",
      simulationForwarder: "0x9eF6468C5f37b976E57d52054c693269479A784d",
    },
  },
  [MONAD_TESTNET_CHAIN_ID]: {
    chain: monadTestnet,
    label: "Monad Testnet",
    hypersyncUrl: "https://monad-testnet.hypersync.xyz",
    logChunkBlocks: 100,
    cre: {
      chainSelectorName: "monad-testnet",
      forwarder: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482",
      simulationForwarder: "0xB9F79d863261869B234c481D1f9A7af84AeAd192",
    },
  },
};

export function isMonadChainId(value: number): value is MonadChainId {
  return value === MONAD_MAINNET_CHAIN_ID || value === MONAD_TESTNET_CHAIN_ID;
}

export function networkFor(chainId: number): NetworkInfo {
  if (!isMonadChainId(chainId)) {
    throw new RangeError(`Chain ${chainId} is not a Monad network; expected 143 or 10143`);
  }
  return NETWORKS[chainId];
}

/** A transaction or address link on the network's explorer. */
export function explorerUrl(chainId: MonadChainId, kind: "tx" | "address", value: string): string {
  return `${NETWORKS[chainId].chain.blockExplorers?.default.url}/${kind}/${value}`;
}
