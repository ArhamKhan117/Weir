/**
 * The keeper's configuration, read once at startup through the shared fail-fast helpers.
 *
 * Addresses, the start block and the network never come from the keeper's own variables: the
 * deployment record in `@weir/shared` is the one source, selected by `MONAD_CHAIN_ID`. What the
 * keeper adds is its signing key, its cadence, the stream thresholds, the cursor location, the
 * HTTP port and the gas policy.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  InvalidEnvVarError,
  loadNetworkConfig,
  networkFor,
  optionalEnv,
  optionalEnvInteger,
  requireDeployment,
  requireEnvBigInt,
  requireEnvUrl,
  requireSecret,
  type Deployment,
  type EnvSource,
  type NetworkConfig,
  type Secret,
} from "@weir/shared";

/** Monad's per-transaction gas cap. A limit above it is refused by the network. */
export const MONAD_TX_GAS_CAP = 30_000_000n;

/**
 * How a gas estimate becomes a gas limit.
 *
 * Monad bills the limit, not the gas used, so every unit of margin is paid on every
 * transaction. The margin is only what covers the estimate being taken a moment before the
 * transaction lands: a percentage for state that moved in between, plus a flat amount for the
 * 63/64 rule on the charger's calls into the hub.
 */
export interface GasPolicy {
  /** Margin on top of the estimate, in basis points. */
  readonly marginBps: bigint;
  /** Flat margin on top of that, in gas. */
  readonly marginGas: bigint;
  /** The lowest limit ever sent, a guard against an implausibly low estimate. */
  readonly floor: bigint;
  /** The highest limit ever sent. A batch whose estimate is above it is split. */
  readonly ceiling: bigint;
}

export const DEFAULT_GAS_POLICY: GasPolicy = {
  marginBps: 500n,
  marginGas: 5_000n,
  floor: 50_000n,
  ceiling: MONAD_TX_GAS_CAP,
};

export const DEFAULTS = {
  intervalMs: 5_000,
  batchSize: 50,
  streamMinCharge: 10_000n,
  streamMaxAgeSeconds: 3_600n,
  cursorPath: ".state/keeper-cursor.json",
  port: 8_791,
  host: "127.0.0.1",
} as const;

/**
 * The largest batch the keeper accepts. A charge from a balance costs well under 150k gas; one from
 * a Mainnet Morpho vault nearer 500k, and a batch whose estimate passes the ceiling is split.
 */
export const MAX_BATCH_SIZE = 200;

export interface HyperSyncConfig {
  readonly url: string;
  readonly token: Secret;
}

export interface KeeperConfig {
  readonly network: NetworkConfig;
  readonly deployment: Deployment;
  /** Blocks per `eth_getLogs` the network's public RPC answers. */
  readonly logChunkBlocks: number;
  /** Set only when both HyperSync variables are. */
  readonly hypersync: HyperSyncConfig | undefined;
  readonly signer: Secret;
  readonly intervalMs: number;
  readonly batchSize: number;
  /** Base units a stream must have accrued before it is worth a charge. */
  readonly streamMinCharge: bigint;
  /** Seconds after its checkpoint a stream is charged whatever it has accrued. */
  readonly streamMaxAgeSeconds: bigint;
  /** Absolute. */
  readonly cursorPath: string;
  readonly host: string;
  readonly port: number;
  readonly gas: GasPolicy;
}

/**
 * Read and validate every keeper variable.
 *
 * @param cwd Where a relative `KEEPER_CURSOR_PATH` is resolved from when there is no workspace
 *        root above it. See {@link resolveStatePath}.
 * @throws {import("@weir/shared").MissingEnvVarError} naming the missing variable.
 * @throws {InvalidEnvVarError} for a malformed one. The key's value is never echoed.
 */
export function loadKeeperConfig(env: EnvSource = process.env, cwd: string = process.cwd()): KeeperConfig {
  const network = loadNetworkConfig(env);
  const deployment = requireDeployment(network.chainId);

  const signer = requireSecret("KEEPER_PRIVATE_KEY", env);
  if (!/^0x[0-9a-fA-F]{64}$/.test(signer.reveal())) {
    throw new InvalidEnvVarError("KEEPER_PRIVATE_KEY", "32 bytes of 0x-prefixed hex");
  }

  return {
    network,
    deployment,
    logChunkBlocks: networkFor(network.chainId).logChunkBlocks,
    hypersync: loadHyperSync(env),
    signer,
    intervalMs: optionalEnvInteger("KEEPER_INTERVAL_MS", env, { min: 500, max: 3_600_000 }) ?? DEFAULTS.intervalMs,
    batchSize: optionalEnvInteger("KEEPER_BATCH_SIZE", env, { min: 1, max: MAX_BATCH_SIZE }) ?? DEFAULTS.batchSize,
    streamMinCharge: optionalBigInt("KEEPER_STREAM_MIN_CHARGE", env) ?? DEFAULTS.streamMinCharge,
    streamMaxAgeSeconds: BigInt(
      optionalEnvInteger("KEEPER_STREAM_MAX_AGE_SECONDS", env, { min: 1 }) ?? DEFAULTS.streamMaxAgeSeconds,
    ),
    cursorPath: resolveStatePath(optionalEnv("KEEPER_CURSOR_PATH", env) ?? DEFAULTS.cursorPath, cwd),
    host: optionalEnv("KEEPER_HOST", env) ?? DEFAULTS.host,
    // A host such as Railway names the port in PORT.
    port: optionalEnvInteger("KEEPER_PORT", env, { min: 0, max: 65_535 }) ?? optionalEnvInteger("PORT", env, { min: 0, max: 65_535 }) ?? DEFAULTS.port,
    gas: loadGasPolicy(env),
  };
}

/** HyperSync is used only when both variables are set; either alone means RPC for history. */
function loadHyperSync(env: EnvSource): HyperSyncConfig | undefined {
  if (optionalEnv("HYPERSYNC_URL", env) === undefined || optionalEnv("HYPERSYNC_API_TOKEN", env) === undefined) {
    return undefined;
  }
  return {
    url: requireEnvUrl("HYPERSYNC_URL", env, { protocols: ["https:", "http:"], bareHost: true }),
    token: requireSecret("HYPERSYNC_API_TOKEN", env),
  };
}

/** The optional `KEEPER_GAS_*` knobs, each defaulting to {@link DEFAULT_GAS_POLICY}. */
export function loadGasPolicy(env: EnvSource): GasPolicy {
  const cap = Number(MONAD_TX_GAS_CAP);
  const policy: GasPolicy = {
    marginBps: BigInt(optionalEnvInteger("KEEPER_GAS_MARGIN_BPS", env, { min: 0, max: 10_000 }) ?? DEFAULT_GAS_POLICY.marginBps),
    marginGas: BigInt(optionalEnvInteger("KEEPER_GAS_MARGIN_GAS", env, { min: 0, max: 1_000_000 }) ?? DEFAULT_GAS_POLICY.marginGas),
    floor: BigInt(optionalEnvInteger("KEEPER_GAS_FLOOR", env, { min: 21_000, max: cap }) ?? DEFAULT_GAS_POLICY.floor),
    ceiling: BigInt(optionalEnvInteger("KEEPER_GAS_CEILING", env, { min: 21_000, max: cap }) ?? DEFAULT_GAS_POLICY.ceiling),
  };
  if (policy.floor > policy.ceiling) {
    throw new InvalidEnvVarError("KEEPER_GAS_FLOOR", `at most KEEPER_GAS_CEILING (${policy.ceiling})`, String(policy.floor));
  }
  return policy;
}

function optionalBigInt(variable: string, env: EnvSource): bigint | undefined {
  return optionalEnv(variable, env) === undefined ? undefined : requireEnvBigInt(variable, env);
}

/**
 * An absolute path for runtime state.
 *
 * A relative path is taken from the workspace root, the directory holding
 * `pnpm-workspace.yaml` above `cwd`, which is also where `.env` lives. That keeps one cursor
 * whether the keeper is started from the root (`pnpm keeper`) or from its package
 * (`pnpm --filter @weir/keeper start`, which runs in `apps/keeper`). Outside a workspace it is
 * taken from `cwd`.
 */
export function resolveStatePath(path: string, cwd: string): string {
  if (isAbsolute(path)) return path;
  return resolve(findWorkspaceRoot(cwd) ?? cwd, path);
}

function findWorkspaceRoot(from: string): string | undefined {
  let directory = resolve(from);
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
