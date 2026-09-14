/**
 * What this project deployed, per Monad network, read from `deployments.json`.
 *
 * The JSON is the one record: `scripts/record-deployment.mjs` writes it from the broadcast
 * artifact, `script/VerifyDeployment.s.sol` checks it against the chain without a key, and every
 * app reads addresses from here rather than from its own configuration, so a redeployment moves
 * everything at once.
 */

import record from "./deployments.json" with { type: "json" };

import { isMonadChainId, type MonadChainId } from "./chains.js";
import type { Address, Hex } from "./types.js";

export interface Deployment {
  network: string;
  chainId: MonadChainId;
  deployedAt: string;
  /** First block to scan for the hub's events. */
  startBlock: number;
  deployer: Address;
  eip712: { name: string; version: string };
  contracts: {
    MandateHub: Address;
    MandateCharger: Address;
    /** Testnet only. */
    TestStablecoin?: Address;
    /** Testnet only. */
    TestSavingsVault?: Address;
    /** Moves savings in and out on the payer's signature; absent where none is deployed. */
    SavingsRouter?: Address;
  };
  /** The hub's accepted assets, in deployment order, by symbol. */
  assets: Record<string, Address>;
  /** The savings vault the router serves for each asset, by the asset's symbol. */
  savings?: Record<string, Address>;
  chainlink: { forwarder: Address; simulationForwarder: Address };
  transactions: Record<string, Hex>;
}

const networks = (record as { networks: Record<string, Deployment> }).networks;

/** The deployment on `chainId`, or `undefined` when nothing is recorded there. */
export function deploymentFor(chainId: number): Deployment | undefined {
  if (!isMonadChainId(chainId)) return undefined;
  return networks[String(chainId)];
}

/** The deployment on `chainId`, refusing a network with nothing recorded. */
export function requireDeployment(chainId: number): Deployment {
  const deployment = deploymentFor(chainId);
  if (deployment === undefined) {
    throw new Error(`Nothing is deployed on chain ${chainId} yet; deployments.json has no entry for it`);
  }
  return deployment;
}
