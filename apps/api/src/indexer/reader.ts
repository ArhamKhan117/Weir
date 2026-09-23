/**
 * `getMandate` as the indexer reads it, to overwrite each touched row with the chain's own state.
 */

import { mandateHubAbi, mandateStatusFromIndex, type MandateRecord } from "@weir/shared";
import { zeroAddress, type Address, type PublicClient } from "viem";

export interface MandateReader {
  /**
   * The mandate as of `blockNumber` (the latest block when omitted), or `undefined` when it does
   * not exist there. Throws when the node cannot serve that block.
   */
  getMandate(id: bigint, blockNumber?: number): Promise<MandateRecord | undefined>;
}

export function createMandateReader(client: PublicClient, hub: Address): MandateReader {
  return {
    async getMandate(id, blockNumber) {
      const m = await client.readContract({
        address: hub,
        abi: mandateHubAbi,
        functionName: "getMandate",
        args: [id],
        ...(blockNumber === undefined ? {} : { blockNumber: BigInt(blockNumber) }),
      });
      if (m.payer === zeroAddress) return undefined;
      return {
        id,
        payer: m.payer,
        merchant: m.merchant,
        asset: m.asset,
        vault: m.vault,
        manager: m.manager,
        amount: m.amount,
        period: m.period,
        nextChargeAt: m.nextChargeAt,
        maxPerCharge: m.maxPerCharge,
        maxTotal: m.maxTotal,
        totalCharged: m.totalCharged,
        expiresAt: m.expiresAt,
        pausedAt: m.pausedAt,
        status: mandateStatusFromIndex(m.status),
      };
    },
  };
}
