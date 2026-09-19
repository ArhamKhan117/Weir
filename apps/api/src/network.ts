/**
 * The chain this process serves and what is deployed on it, as one value every module reads.
 *
 * On Monad it comes from `MONAD_CHAIN_ID` and the deployment record in `@weir/shared`; tests build
 * one directly for a local node with contracts they deployed themselves. Nothing below this module
 * reads the record or the environment, which is what lets the whole API run against anvil.
 */

import {
  MONAD_MAINNET_CHAIN_ID,
  networkFor,
  requireDeployment,
  type NetworkConfig,
} from "@weir/shared";
import { getAddress, isAddressEqual, type Address, type Chain } from "viem";

export interface ApiDeployment {
  /** First block to index. */
  startBlock: number;
  hub: Address;
  /** The hub's EIP-712 domain name. */
  domainName: string;
  /** The hub's accepted assets by symbol, exactly as recorded. */
  assets: Readonly<Record<string, Address>>;
  /** The open-faucet test token, where the network has one. */
  testStablecoin?: Address;
  /** The savings vault offered for each accepted asset that has one, by the asset's symbol. */
  savings: Readonly<Record<string, Address>>;
  /** The router that moves savings in and out on the payer's signature, where one is deployed. */
  router?: Address;
}

export interface ApiNetwork {
  chainId: number;
  chain: Chain;
  rpcUrl: string;
  /** Most blocks one `eth_getLogs` may span on this RPC. */
  logChunkBlocks: number;
  /** Monad Mainnet: no faucet, no dev auth, webhooks over https only. */
  mainnet: boolean;
  deployment: ApiDeployment;
}

/** The network `MONAD_CHAIN_ID` names, with its recorded deployment. */
export function monadNetwork(config: NetworkConfig): ApiNetwork {
  const info = networkFor(config.chainId);
  const record = requireDeployment(config.chainId);
  return {
    chainId: config.chainId,
    chain: info.chain,
    rpcUrl: config.rpcUrl,
    logChunkBlocks: info.logChunkBlocks,
    mainnet: config.chainId === MONAD_MAINNET_CHAIN_ID,
    deployment: {
      startBlock: record.startBlock,
      hub: getAddress(record.contracts.MandateHub),
      domainName: record.eip712.name,
      assets: Object.fromEntries(Object.entries(record.assets).map(([symbol, address]) => [symbol, getAddress(address)])),
      ...(record.contracts.TestStablecoin === undefined ? {} : { testStablecoin: getAddress(record.contracts.TestStablecoin) }),
      savings: Object.fromEntries(Object.entries(record.savings ?? {}).map(([symbol, vault]) => [symbol, getAddress(vault)])),
      ...(record.contracts.SavingsRouter === undefined ? {} : { router: getAddress(record.contracts.SavingsRouter) }),
    },
  };
}

/** The symbol an accepted asset is recorded under, or `undefined` for anything else. */
export function symbolOf(deployment: ApiDeployment, asset: Address): string | undefined {
  for (const [symbol, address] of Object.entries(deployment.assets)) {
    if (isAddressEqual(address, asset)) return symbol;
  }
  return undefined;
}

/** The symbol for display: the recorded one, or the address when the asset is not recorded. */
export function displaySymbol(deployment: ApiDeployment, asset: Address): string {
  return symbolOf(deployment, asset) ?? asset;
}

/** The savings vault offered for `asset`, or `undefined` when it has none. */
export function savingsVaultFor(deployment: ApiDeployment, asset: Address): Address | undefined {
  const symbol = symbolOf(deployment, asset);
  return symbol === undefined ? undefined : deployment.savings[symbol];
}

/** Every token the relayer may submit a permit on: the accepted assets and their savings vaults. */
export function permitTokens(deployment: ApiDeployment): Address[] {
  return [...Object.values(deployment.assets), ...Object.values(deployment.savings)];
}
