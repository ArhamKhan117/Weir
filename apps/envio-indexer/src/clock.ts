/**
 * The time of a block, for the expiry sweep.
 *
 * A block handler is given only the block's number, and expiry is a matter of time: a mandate is
 * expired once a block's timestamp passes its `expiresAt`, with no event to say so. This effect
 * asks an RPC for the block, once per block ever (the answer is cached, and a block's time never
 * changes). The network's keyless public RPC answers by default; `ENVIO_RPC_URL_<chainId>` points
 * it elsewhere.
 *
 * A failed or empty answer (a node behind the indexer, a rate limit) is `null` and is not cached,
 * so the sweep skips that pass and the next one covers it: expiry is cumulative, nothing is lost
 * by a pass that does not run.
 */

import { S, createEffect } from "envio";

import { networkInfo } from "./books.js";

function rpcUrl(chainId: number): string {
  return process.env[`ENVIO_RPC_URL_${chainId}`] ?? networkInfo(chainId).rpcUrl;
}

export const blockTime = createEffect(
  {
    name: "blockTime",
    input: S.number,
    output: S.nullable(S.number),
    rateLimit: { calls: 10, per: "second" },
    cache: true,
    crossChain: false,
  },
  async ({ input: blockNumber, context }) => {
    try {
      const response = await fetch(rpcUrl(context.chain.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBlockByNumber",
          params: [`0x${blockNumber.toString(16)}`, false],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json()) as { result?: { timestamp?: string } | null };
      const timestamp = body.result?.timestamp;
      if (!response.ok || typeof timestamp !== "string") throw new Error(`no block ${blockNumber} (HTTP ${response.status})`);
      return Number(BigInt(timestamp));
    } catch (error) {
      context.cache = false;
      context.log.warn(`could not read the time of block ${blockNumber}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  },
);
