/**
 * The Postgres connection and the migration runner.
 *
 * The URL is a `Secret` and is revealed only into the driver. `search_path` is settable so tests
 * can give each suite a schema of its own inside `weir_test` and run side by side.
 */

import type { Secret } from "@weir/shared";
import postgres from "postgres";

import { MIGRATIONS, type Migration } from "./migrations.js";

export type Sql = postgres.Sql;
/** Anything that runs a query: the pool, a transaction, or a reserved connection. */
export type Db = postgres.ISql;
/** A query fragment to embed in another query. */
export type Fragment = postgres.Fragment;

export interface ConnectOptions {
  /** Schema to create tables in and read from. Defaults to the server's `search_path`. */
  schema?: string;
  max?: number;
}

export function connectDatabase(url: Secret | string, options: ConnectOptions = {}): Sql {
  const raw = typeof url === "string" ? url : url.reveal();
  return postgres(raw, {
    max: options.max ?? 10,
    // `CREATE ... IF NOT EXISTS` notices on every start are noise, not news.
    onnotice: () => undefined,
    ...(options.schema === undefined ? {} : { connection: { search_path: options.schema } }),
  });
}

/** An arbitrary constant: one migration runner at a time per database. */
const MIGRATION_LOCK = 0x7765_6972;

/**
 * Applies every migration not yet recorded, in order, in one transaction under an advisory lock,
 * so two processes starting together never race. Returns the versions it applied.
 */
export async function migrate(sql: Sql, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
    const rows = await tx<{ version: number }[]>`SELECT version FROM schema_migrations`;
    const applied = new Set(rows.map((row) => Number(row.version)));
    const ran: number[] = [];
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(migration.version)) continue;
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO schema_migrations (version, name) VALUES (${migration.version}, ${migration.name})`;
      ran.push(migration.version);
    }
    return ran;
  });
}

/** True when the database answers. */
export async function ping(sql: Db): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
