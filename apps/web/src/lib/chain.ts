/**
 * Reads straight from Monad, for what must be current to the block: balances, allowances and
 * permit nonces. Everything historical comes from the API's index instead.
 */

import { mandateHubAbi, stablecoinAbi } from "@weir/shared";
import { createPublicClient, fallback, http, parseAbi, type Address } from "viem";

import { DEPLOYMENT, IS_TESTNET, NETWORK } from "./config";

/**
 * Every public RPC the network has, in order: when one stops answering, reads move to the next
 * instead of failing, and each is retried before it is given up on.
 */
const RPCS = IS_TESTNET
  ? ["https://testnet-rpc.monad.xyz", "https://rpc-testnet.monadinfra.com"]
  : [...(NETWORK.chain.rpcUrls.default.http as readonly string[])];

export const client = createPublicClient({
  chain: NETWORK.chain,
  transport: fallback(RPCS.map((url) => http(url, { retryCount: 2, timeout: 10_000 }))),
});

export function balanceOf(token: Address, owner: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: stablecoinAbi, functionName: "balanceOf", args: [owner] });
}

export function allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: stablecoinAbi, functionName: "allowance", args: [owner, spender] });
}

export function permitNonce(token: Address, owner: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: stablecoinAbi, functionName: "nonces", args: [owner] });
}

export const vaultAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
]);

/**
 * What a vault position is worth in its asset right now: what redeeming every share would pay.
 * Not `maxWithdraw`, which some vaults, Morpho's among them, answer with zero for everyone.
 */
export async function vaultValue(vault: Address, owner: Address): Promise<bigint> {
  const shares = await client.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [owner] });
  if (shares === 0n) return 0n;
  return client.readContract({ address: vault, abi: vaultAbi, functionName: "previewRedeem", args: [shares] });
}

/** Mandates ever created on the hub: the landing page's live figure. */
export async function mandatesCreated(): Promise<bigint> {
  const next = await client.readContract({
    address: DEPLOYMENT.contracts.MandateHub,
    abi: mandateHubAbi,
    functionName: "nextMandateId",
  });
  return next - 1n;
}
