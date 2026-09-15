/**
 * Where the plugin talks to: the Weir API, and optionally a Monad RPC endpoint and a chain the
 * operator insists on.
 *
 * - The API comes from `--api`, then `WEIR_API_URL`, then `http://localhost:8790`.
 * - Chain reads (balances, allowances, permit nonces, a mandate's state) go to `MONAD_RPC_URL`
 *   when it is set, and to the network's public RPC otherwise.
 * - The chain itself comes from the API: the checkout answer for a plan, `/health` for everything
 *   else. `MONAD_CHAIN_ID`, when set, is a guard: an API on another network is refused rather
 *   than signed for.
 */

import { isMonadChainId, networkFor, type MonadChainId } from "@weir/shared";

import { WeirError } from "./errors.js";

export const DEFAULT_API_URL = "http://localhost:8790";

export interface Settings {
  /** The API's origin and base path, without a trailing slash. */
  readonly apiUrl: string;
  /** A Monad JSON-RPC endpoint for reads; the network's public one when absent. */
  readonly rpcUrl?: string;
  /** The chain the operator expects, from `MONAD_CHAIN_ID`. */
  readonly expectedChainId?: MonadChainId;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

function httpUrl(value: string, source: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WeirError("INVALID_INPUT", `${source} "${value}" is not a URL`, "Give a full URL such as http://localhost:8790.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WeirError("INVALID_INPUT", `${source} "${value}" is not an http or https URL`, "Give a full URL such as http://localhost:8790.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function resolveSettings(flags: { api?: string | undefined }, env: EnvSource): Settings {
  const fromFlag = nonEmpty(flags.api);
  const fromEnv = nonEmpty(env["WEIR_API_URL"]);
  const apiUrl =
    fromFlag !== undefined ? httpUrl(fromFlag, "--api") : fromEnv !== undefined ? httpUrl(fromEnv, "WEIR_API_URL") : DEFAULT_API_URL;

  const rpc = nonEmpty(env["MONAD_RPC_URL"]);
  const rawChain = nonEmpty(env["MONAD_CHAIN_ID"]);
  let expectedChainId: MonadChainId | undefined;
  if (rawChain !== undefined) {
    const parsed = Number(rawChain);
    if (!Number.isInteger(parsed) || !isMonadChainId(parsed)) {
      throw new WeirError("INVALID_INPUT", `MONAD_CHAIN_ID "${rawChain}" is not a Monad network`, "Set it to 143 for Mainnet or 10143 for Testnet, or unset it.");
    }
    expectedChainId = parsed;
  }

  return {
    apiUrl,
    ...(rpc === undefined ? {} : { rpcUrl: httpUrl(rpc, "MONAD_RPC_URL") }),
    ...(expectedChainId === undefined ? {} : { expectedChainId }),
  };
}

/**
 * The chain an API answer names, checked against the operator's `MONAD_CHAIN_ID`. Signing for a
 * chain the operator did not expect is exactly the mistake worth stopping.
 */
export function chainOf(apiChainId: number, settings: Settings): MonadChainId {
  if (!isMonadChainId(apiChainId)) {
    throw new WeirError(
      "UNSUPPORTED_CHAIN",
      `The Weir API at ${settings.apiUrl} is on chain ${apiChainId}, which is not a Monad network`,
      "Point --api or WEIR_API_URL at a Weir API on Monad (143) or Monad Testnet (10143).",
    );
  }
  if (settings.expectedChainId !== undefined && settings.expectedChainId !== apiChainId) {
    throw new WeirError(
      "CHAIN_MISMATCH",
      `The Weir API at ${settings.apiUrl} is on ${networkFor(apiChainId).label} (${apiChainId}), but MONAD_CHAIN_ID is ${settings.expectedChainId}`,
      "Point --api at the API for the network you mean, or change MONAD_CHAIN_ID.",
    );
  }
  return apiChainId;
}
