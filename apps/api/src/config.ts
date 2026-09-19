/**
 * The API's environment, read once at startup.
 *
 * Secrets arrive as `Secret` through `requireSecret`, so a key, a token or the database URL can be
 * passed around and even logged by mistake without its value leaving the process. Optional groups
 * degrade rather than fail: without a relayer key the relay and the faucet answer 503, without
 * Privy the merchant routes do, and each is announced once at startup.
 *
 * Two combinations are refused outright because they are never an accident worth serving:
 * `WEIR_DEV_AUTH=1` on Mainnet, which would let anyone act as any merchant, and a faucet amount the
 * test token would refuse to mint.
 */

import {
  InvalidEnvVarError,
  MONAD_MAINNET_CHAIN_ID,
  MissingEnvVarError,
  loadNetworkConfig,
  optionalEnv,
  optionalEnvInteger,
  requireEnvUrl,
  requireSecret,
  type EnvSource,
  type NetworkConfig,
  type Secret,
  type SecretEnvVar,
} from "@weir/shared";

/** `TestStablecoin.MAX_MINT`: the most one `mint` may create. */
export const TEST_STABLECOIN_MAX_MINT = 10_000_000_000n;

export const DEFAULT_API_PORT = 8790;
export const DEFAULT_FAUCET_AMOUNT = 100_000_000n;

export interface ApiConfig {
  network: NetworkConfig;
  port: number;
  /** Exact browser origins allowed to call the API. */
  allowedOrigins: string[];
  databaseUrl: Secret;
  relayerKey?: Secret;
  privy?: { appId: string; appSecret: Secret };
  /** `Authorization: Dev <address>` accepted as a merchant. Never on Mainnet. */
  devAuth: boolean;
  faucetAmount: bigint;
  hypersync?: { url: string; token: Secret };
  /** The Envio HyperIndex database, read for analytics; without it those routes answer 503. */
  envioDatabaseUrl?: Secret;
  /** Web Push for reminders: the VAPID key pair and the contact push services may use. */
  push?: { publicKey: string; privateKey: Secret; subject: string };
  /** Why an optional group is off, for the startup log. Never carries a value. */
  notes: string[];
}

function optionalSecret(variable: SecretEnvVar, env: EnvSource): Secret | undefined {
  try {
    return requireSecret(variable, env);
  } catch (error) {
    if (error instanceof MissingEnvVarError) return undefined;
    throw error;
  }
}

function readOrigins(env: EnvSource): string[] {
  const raw = optionalEnv("API_ALLOWED_ORIGINS", env);
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      let origin: string;
      try {
        origin = new URL(entry).origin;
      } catch {
        throw new InvalidEnvVarError("API_ALLOWED_ORIGINS", "a comma-separated list of origins such as https://app.example", entry);
      }
      if (origin !== entry) {
        throw new InvalidEnvVarError("API_ALLOWED_ORIGINS", "origins only, with no path or trailing slash", entry);
      }
      return origin;
    });
}

function readDevAuth(env: EnvSource): boolean {
  const raw = optionalEnv("WEIR_DEV_AUTH", env);
  if (raw === undefined || raw === "0") return false;
  if (raw === "1") return true;
  throw new InvalidEnvVarError("WEIR_DEV_AUTH", "0 or 1", raw);
}

function readFaucetAmount(env: EnvSource): bigint {
  const raw = optionalEnv("FAUCET_AMOUNT", env);
  if (raw === undefined) return DEFAULT_FAUCET_AMOUNT;
  if (!/^\d+$/.test(raw)) throw new InvalidEnvVarError("FAUCET_AMOUNT", "base units as a whole number", raw);
  const amount = BigInt(raw);
  if (amount === 0n || amount > TEST_STABLECOIN_MAX_MINT) {
    throw new InvalidEnvVarError("FAUCET_AMOUNT", `between 1 and ${TEST_STABLECOIN_MAX_MINT} (the test token's per-mint cap)`, raw);
  }
  return amount;
}

/**
 * @throws {MissingEnvVarError} for a required variable, named.
 * @throws {InvalidEnvVarError} for a malformed one; secret values are never quoted.
 */
export function loadApiConfig(env: EnvSource = process.env): ApiConfig {
  const network = loadNetworkConfig(env);
  const notes: string[] = [];

  const devAuth = readDevAuth(env);
  if (devAuth && network.chainId === MONAD_MAINNET_CHAIN_ID) {
    throw new InvalidEnvVarError("WEIR_DEV_AUTH", "0 on Monad Mainnet: dev auth lets anyone act as any merchant");
  }

  const relayerKey = optionalSecret("RELAYER_PRIVATE_KEY", env);
  if (relayerKey !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(relayerKey.reveal())) {
    throw new InvalidEnvVarError("RELAYER_PRIVATE_KEY", "32 bytes of 0x-prefixed hex");
  }
  if (relayerKey === undefined) notes.push("RELAYER_PRIVATE_KEY is not set: the relay and the faucet answer 503");

  const appId = optionalEnv("PRIVY_APP_ID", env);
  const appSecret = optionalSecret("PRIVY_APP_SECRET", env);
  const privy = appId !== undefined && appSecret !== undefined ? { appId, appSecret } : undefined;
  if (privy === undefined) {
    const missing = [appId === undefined ? "PRIVY_APP_ID" : null, appSecret === undefined ? "PRIVY_APP_SECRET" : null]
      .filter((name) => name !== null)
      .join(" and ");
    notes.push(
      devAuth
        ? `${missing} not set: merchants sign in with dev auth only`
        : `${missing} not set: the merchant routes answer 503`,
    );
  }

  const hypersyncToken = optionalSecret("HYPERSYNC_API_TOKEN", env);
  const hypersyncUrl = optionalEnv("HYPERSYNC_URL", env) === undefined ? undefined : requireEnvUrl("HYPERSYNC_URL", env);
  const hypersync = hypersyncUrl !== undefined && hypersyncToken !== undefined ? { url: hypersyncUrl, token: hypersyncToken } : undefined;
  if (hypersync === undefined) notes.push("HyperSync is not configured: catch-up reads the RPC in small chunks");

  const envioDatabaseUrl = optionalSecret("ENVIO_DATABASE_URL", env);
  if (envioDatabaseUrl === undefined) notes.push("ENVIO_DATABASE_URL is not set: no analytics from Envio HyperIndex");

  const push = readPush(env);
  if (push === undefined) notes.push("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are not set: no push reminders");

  return {
    network,
    // A host such as Railway names the port in PORT.
    port: optionalEnvInteger("API_PORT", env, { min: 0, max: 65_535 }) ?? optionalEnvInteger("PORT", env, { min: 0, max: 65_535 }) ?? DEFAULT_API_PORT,
    allowedOrigins: readOrigins(env),
    databaseUrl: requireSecret("DATABASE_URL", env),
    ...(relayerKey === undefined ? {} : { relayerKey }),
    ...(privy === undefined ? {} : { privy }),
    devAuth,
    faucetAmount: readFaucetAmount(env),
    ...(hypersync === undefined ? {} : { hypersync }),
    ...(envioDatabaseUrl === undefined ? {} : { envioDatabaseUrl }),
    ...(push === undefined ? {} : { push }),
    notes,
  };
}

/** All three VAPID settings, or none: half a key pair is a mistake, not a choice. */
function readPush(env: EnvSource): ApiConfig["push"] {
  const publicKey = optionalEnv("VAPID_PUBLIC_KEY", env);
  const privateKey = optionalSecret("VAPID_PRIVATE_KEY", env);
  const subject = optionalEnv("VAPID_SUBJECT", env);
  if (publicKey === undefined && privateKey === undefined && subject === undefined) return undefined;
  if (publicKey === undefined || privateKey === undefined || subject === undefined) {
    throw new InvalidEnvVarError("VAPID_PUBLIC_KEY", "set together with VAPID_PRIVATE_KEY and VAPID_SUBJECT, or none of them");
  }
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(publicKey)) throw new InvalidEnvVarError("VAPID_PUBLIC_KEY", "a base64url P-256 public key");
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(privateKey.reveal())) throw new InvalidEnvVarError("VAPID_PRIVATE_KEY", "a base64url P-256 private key");
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) throw new InvalidEnvVarError("VAPID_SUBJECT", "a mailto: address or an https URL");
  return { publicKey, privateKey, subject };
}
