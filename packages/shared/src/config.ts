/**
 * Typed, fail-fast environment loading.
 *
 * Two rules shape this module.
 *
 * **Nothing is validated at import time.** Every loader reads `process.env` when it is called,
 * so importing this module can never throw. The variables split into groups that different
 * processes need: the keeper needs a signing key, the web app needs none. A caller that needs a
 * group calls its loader and gets a named failure; a caller that does not never asks.
 *
 * **A missing variable is named.** {@link MissingEnvVarError} carries the variable name in
 * `.variable` and in its message, so the failure says which line of `.env` to fix rather than
 * that something is unset. Secret-valued variables are the one asymmetry: their errors name the
 * variable and never carry the value. See {@link Secret}.
 */

import { createPublicClient, fallback, getAddress, http, isAddress, type Address, type Hex, type PublicClient, type Transport } from "viem";

import { isMonadChainId, networkFor, type MonadChainId } from "./chains.js";

/*//////////////////////////////////////////////////////////////
                              ERRORS
//////////////////////////////////////////////////////////////*/

/** A required variable is unset, or set to an empty or whitespace-only value. */
export class MissingEnvVarError extends Error {
  constructor(
    readonly variable: string,
    hint?: string,
  ) {
    super(
      `Missing required environment variable ${variable}.` +
        `${hint === undefined ? "" : ` ${hint}`} Copy .env.example to .env and fill it in.`,
    );
    this.name = "MissingEnvVarError";
  }
}

/**
 * A variable is set but malformed.
 *
 * `observed` is omitted for secret-valued variables, so the value cannot reach a log
 * through an error message.
 */
export class InvalidEnvVarError extends Error {
  constructor(
    readonly variable: string,
    expectation: string,
    observed?: string,
  ) {
    super(
      `Environment variable ${variable} must be ${expectation}` +
        `${observed === undefined ? "" : `, observed ${observed}`}.`,
    );
    this.name = "InvalidEnvVarError";
  }
}

/*//////////////////////////////////////////////////////////////
                           ENV READING
//////////////////////////////////////////////////////////////*/

/** Anything shaped like `process.env`. Injectable so tests need no global mutation. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Trimmed value, or `undefined` for unset, empty, and whitespace-only alike. */
function readRaw(env: EnvSource, variable: string): string | undefined {
  const raw = env[variable];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/*//////////////////////////////////////////////////////////////
                             SECRETS
//////////////////////////////////////////////////////////////*/

/** Variables whose values must never reach a log, an error message, or a response body. */
export const SECRET_ENV_VARS = [
  "DEPLOYER_PRIVATE_KEY",
  "RELAYER_PRIVATE_KEY",
  "KEEPER_PRIVATE_KEY",
  "HYPERSYNC_API_TOKEN",
  "DATABASE_URL",
  "ENVIO_DATABASE_URL",
  "PRIVY_APP_SECRET",
  "VAPID_PRIVATE_KEY",
] as const;

export type SecretEnvVar = (typeof SECRET_ENV_VARS)[number];

/**
 * A secret value that has to be asked for explicitly.
 *
 * The value lives in a private field, and `toString`/`toJSON` return a redaction
 * marker. Interpolating a `Secret` into a template literal, passing one to
 * `console.log`, or serializing a config object that holds one all produce
 * `[redacted KEEPER_PRIVATE_KEY]` instead of the key. Reading it takes
 * {@link Secret.reveal}, which is easy to grep for at review time.
 */
export class Secret {
  readonly #value: string;

  constructor(
    readonly variable: SecretEnvVar,
    value: string,
  ) {
    this.#value = value;
  }

  /** The plaintext value. Pass it to a signer; never to a logger. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return `[redacted ${this.variable}]`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/**
 * Read a secret-valued variable.
 *
 * @throws {MissingEnvVarError} naming the variable, never carrying its value.
 */
export function requireSecret(variable: SecretEnvVar, env: EnvSource = process.env): Secret {
  const raw = readRaw(env, variable);
  if (raw === undefined) {
    throw new MissingEnvVarError(variable);
  }
  return new Secret(variable, raw);
}

/*//////////////////////////////////////////////////////////////
                         TYPED ACCESSORS
//////////////////////////////////////////////////////////////*/

/** @throws {MissingEnvVarError} if unset or blank. */
export function requireEnv(variable: string, env: EnvSource = process.env): string {
  const raw = readRaw(env, variable);
  if (raw === undefined) {
    throw new MissingEnvVarError(variable);
  }
  return raw;
}

/** `undefined` for unset or blank, so an empty `.env` line reads as absent. */
export function optionalEnv(variable: string, env: EnvSource = process.env): string | undefined {
  return readRaw(env, variable);
}

/** @throws {MissingEnvVarError} @throws {InvalidEnvVarError} */
export function requireEnvAddress(variable: string, env: EnvSource = process.env): Address {
  const raw = requireEnv(variable, env);
  if (!isAddress(raw)) {
    throw new InvalidEnvVarError(variable, "a 20-byte EVM address", raw);
  }
  // Checksummed on the way out, so downstream address comparisons are string equality.
  return getAddress(raw);
}

/** Bounds shared by the required and optional integer readers. */
export interface IntegerBounds {
  min?: number;
  max?: number;
}

/** One parser, so an optional variable is validated exactly as a required one is. */
function parseInteger(variable: string, raw: string, bounds: IntegerBounds): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new InvalidEnvVarError(variable, "an integer", raw);
  }
  const value = Number(raw);
  const { min, max } = bounds;
  if (!Number.isSafeInteger(value)) {
    throw new InvalidEnvVarError(variable, "an integer within the safe range", raw);
  }
  if (min !== undefined && value < min) {
    throw new InvalidEnvVarError(variable, `an integer at least ${min}`, raw);
  }
  if (max !== undefined && value > max) {
    throw new InvalidEnvVarError(variable, `an integer at most ${max}`, raw);
  }
  return value;
}

/** @throws {MissingEnvVarError} @throws {InvalidEnvVarError} */
export function requireEnvInteger(
  variable: string,
  env: EnvSource = process.env,
  bounds: IntegerBounds = {},
): number {
  return parseInteger(variable, requireEnv(variable, env), bounds);
}

/**
 * Read an optional integer-valued tuning knob.
 *
 * `undefined` for unset or blank, so the caller applies its own default. A value that is
 * *present but out of bounds* still throws: an operator who typed a chunk size of zero
 * meant something, and silently substituting the default would hide the typo behind
 * behaviour that looks correct.
 *
 * @throws {InvalidEnvVarError} if set to something that is not an in-bounds integer.
 */
export function optionalEnvInteger(
  variable: string,
  env: EnvSource = process.env,
  bounds: IntegerBounds = {},
): number | undefined {
  const raw = optionalEnv(variable, env);
  return raw === undefined ? undefined : parseInteger(variable, raw, bounds);
}

/** @throws {MissingEnvVarError} @throws {InvalidEnvVarError} */
export function requireEnvBigInt(variable: string, env: EnvSource = process.env): bigint {
  const raw = requireEnv(variable, env);
  if (!/^\d+$/.test(raw)) {
    throw new InvalidEnvVarError(variable, "a non-negative integer", raw);
  }
  return BigInt(raw);
}

/** @throws {MissingEnvVarError} @throws {InvalidEnvVarError} */
export function requireEnvHex(
  variable: string,
  byteLength: number,
  env: EnvSource = process.env,
): Hex {
  const raw = requireEnv(variable, env);
  if (!new RegExp(`^0x[0-9a-fA-F]{${byteLength * 2}}$`).test(raw)) {
    throw new InvalidEnvVarError(variable, `${byteLength} bytes of 0x-prefixed hex`, raw);
  }
  return raw as Hex;
}

/**
 * Read a URL-valued variable.
 *
 * `bareHost` rejects any path, query, or fragment, for a base URL a client appends its own
 * paths to: a path there produces a doubled segment and a 404 that reads like a network fault.
 *
 * @throws {MissingEnvVarError} @throws {InvalidEnvVarError}
 */
export function requireEnvUrl(
  variable: string,
  env: EnvSource = process.env,
  options: { protocols?: readonly string[]; bareHost?: boolean } = {},
): string {
  const raw = requireEnv(variable, env);
  const { protocols = ["http:", "https:"], bareHost = false } = options;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new InvalidEnvVarError(variable, "an absolute URL", raw);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new InvalidEnvVarError(variable, `a URL using ${protocols.join(" or ")}`, raw);
  }
  if (bareHost && (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "")) {
    throw new InvalidEnvVarError(
      variable,
      "a bare host with no path, query, or fragment; the client appends its own path",
      raw,
    );
  }
  // `new URL("https://host")` normalizes to a trailing slash; callers concatenate paths.
  return bareHost ? `${parsed.protocol}//${parsed.host}` : raw;
}

/*//////////////////////////////////////////////////////////////
                          CONFIG GROUPS
//////////////////////////////////////////////////////////////*/

/** Which Monad network a process runs against, and how it reaches it. */
export interface NetworkConfig {
  chainId: MonadChainId;
  rpcUrl: string;
}

/**
 * `MONAD_CHAIN_ID` selects the network and with it the deployment record every script reads;
 * `MONAD_RPC_URL` is optional and defaults to the network's public endpoint.
 *
 * @throws {MissingEnvVarError} @throws {InvalidEnvVarError}
 */
export function loadNetworkConfig(env: EnvSource = process.env): NetworkConfig {
  const chainId = requireEnvInteger("MONAD_CHAIN_ID", env);
  if (!isMonadChainId(chainId)) {
    throw new InvalidEnvVarError("MONAD_CHAIN_ID", "143 (Monad) or 10143 (Monad Testnet)", String(chainId));
  }
  const rpcUrl = optionalEnv("MONAD_RPC_URL", env) === undefined
    ? (networkFor(chainId).chain.rpcUrls.default.http[0] ?? "")
    : requireEnvUrl("MONAD_RPC_URL", env);
  return { chainId, rpcUrl };
}

/** Each network's public RPCs, the backups behind whichever one is configured. */
const PUBLIC_RPCS: Readonly<Record<MonadChainId, readonly string[]>> = {
  143: ["https://rpc.monad.xyz", "https://rpc1.monad.xyz"],
  10143: ["https://testnet-rpc.monad.xyz", "https://rpc-testnet.monadinfra.com"],
};

/**
 * The transport to the configured network: the configured RPC first, then the network's public
 * ones, each retried before the next is tried, so one endpoint going down neither stops the relayer
 * nor the keeper. A local node (an Anvil fork in a test) gets no backups, so nothing meant for it
 * can ever reach a real network.
 */
export function monadTransport(config: { chainId: number; rpcUrl: string }): Transport {
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(config.rpcUrl);
  const backups = isMonadChainId(config.chainId) ? PUBLIC_RPCS[config.chainId] : [];
  const urls = local ? [config.rpcUrl] : [config.rpcUrl, ...backups.filter((url) => url !== config.rpcUrl)];
  const transports = urls.map((url) => http(url, { retryCount: 2 }));
  return transports.length === 1 ? (transports[0] as Transport) : fallback(transports);
}

/** A read client for the configured network. */
export function createMonadClient(config: NetworkConfig): PublicClient {
  return createPublicClient({ chain: networkFor(config.chainId).chain, transport: monadTransport(config) });
}
