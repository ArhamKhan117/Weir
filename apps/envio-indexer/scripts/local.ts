/**
 * Runs the indexer on this machine against the local Postgres, with no Docker and no Hasura.
 *
 *   pnpm local                  envio start: resume where the database left off
 *   pnpm local start -r         drop what is indexed and sync again from the start block
 *   pnpm local <args...>        any other envio command, in the same environment
 *
 * See `env.ts` for what is read from the repository's `.env`. The database is created on first
 * run. It is the indexer's own: the API's tables are never touched.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { indexerEnv, requireNode22 } from "./env.js";

requireNode22();
const { env, postgres: pg } = indexerEnv();
if (env.ENVIO_API_TOKEN === undefined) {
  console.error("No HyperSync token: set HYPERSYNC_API_TOKEN in the repository's .env, or ENVIO_API_TOKEN.");
  process.exit(1);
}

const admin = postgres({ ...pg, database: "postgres", max: 1, onnotice: () => {} });
try {
  const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${pg.database}`;
  if (exists === undefined) {
    await admin`CREATE DATABASE ${admin(pg.database)}`;
    console.log(`local: created database ${pg.database}`);
  }
} finally {
  await admin.end();
}

const args = process.argv.slice(2);
const child = spawn(fileURLToPath(new URL("../node_modules/.bin/envio", import.meta.url)), args.length === 0 ? ["start"] : args, {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
