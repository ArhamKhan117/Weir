/**
 * Test dollars on Monad Testnet, from the API's faucet, so an agent with an empty wallet can try a
 * subscription end to end. The API refuses on Mainnet; so does this, before asking.
 */

import { explorerUrl, type MonadChainId } from "@weir/shared";
import type { Address, Hex } from "viem";

import type { Deps } from "./deps.js";
import { WeirError } from "./errors.js";
import { chainOf } from "./settings.js";

export interface FaucetReport {
  chainId: MonadChainId;
  address: Address;
  asset: Address;
  /** Base units sent. */
  amount: string;
  transaction: Hex;
  explorerUrl: string;
}

export async function requestTestDollars(deps: Deps, address: Address): Promise<FaucetReport> {
  const health = await deps.api.health();
  const chainId = chainOf(health.chainId, deps.settings);
  if (chainId !== 10143) {
    throw new WeirError("NOT_TESTNET", "Test dollars exist on Monad Testnet only; this API is on Monad Mainnet", "Point --api at a Weir API on Monad Testnet.");
  }
  const granted = await deps.api.faucet(address);
  return {
    chainId,
    address,
    asset: granted.asset,
    amount: granted.amount,
    transaction: granted.transaction,
    explorerUrl: explorerUrl(chainId, "tx", granted.transaction),
  };
}
