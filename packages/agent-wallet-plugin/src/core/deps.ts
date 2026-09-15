/**
 * What every flow reads from: the API, the chain, the clock and the operator's settings. Built once
 * per command run; tests build their own with fakes.
 */

import type { MonadChainId } from "@weir/shared";

import { createApi, type WeirApi } from "./api.js";
import { createChainReader, type ChainReader } from "./chain.js";
import type { Settings } from "./settings.js";

export interface Deps {
  readonly settings: Settings;
  readonly api: WeirApi;
  chain(chainId: MonadChainId): ChainReader;
  /** Unix seconds. */
  now(): number;
  /** For rendering dates; the machine's own when absent. */
  readonly timeZone?: string;
}

export function createDeps(settings: Settings): Deps {
  const readers = new Map<MonadChainId, ChainReader>();
  return {
    settings,
    api: createApi(settings.apiUrl),
    chain(chainId) {
      let reader = readers.get(chainId);
      if (reader === undefined) {
        reader = createChainReader(chainId, settings.rpcUrl);
        readers.set(chainId, reader);
      }
      return reader;
    },
    now: () => Math.floor(Date.now() / 1000),
  };
}
