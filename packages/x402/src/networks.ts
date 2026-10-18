/**
 * Where Weir's meter and facilitator are on each Monad network, so a paywall needs only a price,
 * a payee and an asset.
 */

import { MONAD_MAINNET_CHAIN_ID, MONAD_TESTNET_CHAIN_ID, requireDeployment } from "@weir/shared";
import { getAddress, type Address } from "viem";

/** Weir's public APIs, each the facilitator for its network. */
export const WEIR_FACILITATORS: Readonly<Record<number, string>> = {
  [MONAD_MAINNET_CHAIN_ID]: "https://api-mainnet-production-fc07.up.railway.app",
  [MONAD_TESTNET_CHAIN_ID]: "https://api-testnet-production-9789.up.railway.app",
};

/** The meter, its EIP-712 domain and the facilitator on `chainId`, for {@link createPaywall}. */
export function weirMeter(chainId: number, facilitator?: string): { chainId: number; meter: Address; name: string; version: string; facilitator: string } {
  const record = requireDeployment(chainId);
  const meter = record.contracts.MandateMeter;
  if (meter === undefined) throw new Error(`No MandateMeter is deployed on chain ${chainId}`);
  const url = facilitator ?? WEIR_FACILITATORS[chainId];
  if (url === undefined) throw new Error(`No Weir facilitator is known for chain ${chainId}`);
  return { chainId, meter: getAddress(meter), name: record.eip712.name, version: record.eip712.version, facilitator: url };
}
