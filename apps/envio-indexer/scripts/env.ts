/**
 * The environment Envio reads, derived from the repository's `.env` for running this indexer on
 * the same machine as the Weir API, with no Docker:
 *
 *   ENVIO_API_TOKEN          from HYPERSYNC_API_TOKEN
 *   ENVIO_PG_HOST/PORT/...   from DATABASE_URL: the API's server, in a database of its own
 *   ENVIO_PG_DATABASE        weir_envio unless set, and never the API's database
 *   ENVIO_HASURA             false: Hasura is a container, and there is none here
 *   ENVIO_RPC_URL_<chain>    from MONAD_RPC_URL, for the expiry sweep's block times
 *
 * Anything already set in the process environment wins. No value is ever printed.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoEnv = fileURLToPath(new URL("../../../.env", import.meta.url));

export const DEFAULT_DATABASE = "weir_envio";

type Env = Record<string, string | undefined>;

/** KEY=VALUE lines, with optional quotes, `#` comments and `export`. */
function parseDotenv(text: string): Env {
  const values: Env = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, key, rest] = match as unknown as [string, string, string];
    const quoted = /^(["'])(.*)\1$/.exec(rest);
    values[key] = quoted === null ? rest.replace(/\s+#.*$/, "") : (quoted[2] ?? "");
  }
  return values;
}

export interface IndexerEnv {
  /** The environment to run Envio with. */
  env: Env;
  /** The repository's `.env` under the process environment, for anything else a script needs. */
  source: Env;
  /** The indexer's own database. */
  postgres: { host: string; port: number; user?: string; password?: string; database: string };
}

export function indexerEnv(): IndexerEnv {
  const fromFile = existsSync(repoEnv) ? parseDotenv(readFileSync(repoEnv, "utf8")) : {};
  const source: Env = { ...fromFile, ...process.env };
  const env: Env = { ...process.env };

  if (env.ENVIO_API_TOKEN === undefined && source.HYPERSYNC_API_TOKEN !== undefined) {
    env.ENVIO_API_TOKEN = source.HYPERSYNC_API_TOKEN;
  }

  let apiDatabase: string | undefined;
  if (source.DATABASE_URL !== undefined) {
    const url = new URL(source.DATABASE_URL);
    apiDatabase = decodeURIComponent(url.pathname.slice(1));
    env.ENVIO_PG_HOST ??= url.hostname;
    env.ENVIO_PG_PORT ??= url.port === "" ? "5432" : url.port;
    env.ENVIO_PG_USER ??= decodeURIComponent(url.username);
    if (url.password !== "") env.ENVIO_PG_PASSWORD ??= decodeURIComponent(url.password);
  }
  const database = (env.ENVIO_PG_DATABASE ??= DEFAULT_DATABASE);
  if (database === apiDatabase) {
    throw new Error(`ENVIO_PG_DATABASE names the API's own database; the indexer needs one of its own (default ${DEFAULT_DATABASE})`);
  }

  env.ENVIO_HASURA ??= "false";
  if (source.MONAD_RPC_URL !== undefined && source.MONAD_CHAIN_ID !== undefined) {
    env[`ENVIO_RPC_URL_${source.MONAD_CHAIN_ID}`] ??= source.MONAD_RPC_URL;
  }

  return {
    env,
    source,
    postgres: {
      host: env.ENVIO_PG_HOST ?? "localhost",
      port: Number(env.ENVIO_PG_PORT ?? 5432),
      ...(env.ENVIO_PG_USER === undefined ? {} : { user: env.ENVIO_PG_USER }),
      ...(env.ENVIO_PG_PASSWORD === undefined ? {} : { password: env.ENVIO_PG_PASSWORD }),
      database,
    },
  };
}

/** Refuses to go on under a Node the envio runtime does not support. */
export function requireNode22(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    console.error(`Envio needs Node 22 or later; this is ${process.versions.node}.`);
    process.exit(1);
  }
}
