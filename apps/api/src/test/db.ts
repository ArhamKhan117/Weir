/**
 * A Postgres schema of the suite's own, inside the `weir_test` database.
 *
 * Tests never touch the database `DATABASE_URL` names: that is the live index. The test database
 * is the same URL with `_test` appended to the database name (`weir` becomes `weir_test`), created
 * on first run through the server's `postgres` maintenance database. Each suite then creates a
 * fresh schema in it, applies the migrations there, and removes it when done, so suites run side by
 * side without seeing each other's rows.
 *
 * `DATABASE_URL` comes from the environment, else from the repository's `.env`, else the local
 * default. Where no server answers, {@link openTestDatabase} returns `undefined` and the suite
 * skips. The URL is never printed.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { requireSecret } from "@weir/shared";
import postgres from "postgres";

import { connectDatabase, migrate, type Sql } from "../db/database.js";

const LOCAL_DEFAULT = "postgres://localhost:5432/weir";

function liveUrl(): string {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const text = readFileSync(fileURLToPath(new URL("../../../../.env", import.meta.url)), "utf8");
    const env: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
      if (match?.[1] !== undefined) env.DATABASE_URL = match[1].trim().replace(/^["']|["']$/g, "");
    }
    return requireSecret("DATABASE_URL", env).reveal();
  } catch {
    return LOCAL_DEFAULT;
  }
}

/** The live URL with `_test` on the database name, so it can never be the live database. */
export function testDatabaseUrl(live = liveUrl()): string {
  const url = new URL(live);
  const name = url.pathname.replace(/^\//, "") || "weir";
  url.pathname = `/${name.endsWith("_test") ? name : `${name}_test`}`;
  return url.toString();
}

async function ensureDatabase(url: string): Promise<boolean> {
  const probe = postgres(url, { max: 1, onnotice: () => undefined, connect_timeout: 3 });
  try {
    await probe`SELECT 1`;
    return true;
  } catch (error) {
    // 3D000: the database does not exist yet. Anything else: no usable server.
    if ((error as { code?: string }).code !== "3D000") return false;
  } finally {
    await probe.end({ timeout: 1 });
  }
  const name = new URL(url).pathname.slice(1);
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const admin = postgres(maintenance.toString(), { max: 1, onnotice: () => undefined, connect_timeout: 3 });
  try {
    await admin.unsafe(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    return true;
  } catch (error) {
    // Another suite created it first.
    return (error as { code?: string }).code === "42P04";
  } finally {
    await admin.end({ timeout: 1 });
  }
}

export interface TestDatabase {
  sql: Sql;
  schema: string;
  /** Deletes every row, keeping the schema. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A migrated schema of its own, or `undefined` when no Postgres is reachable. */
export async function openTestDatabase(label: string): Promise<TestDatabase | undefined> {
  const url = testDatabaseUrl();
  if (!(await ensureDatabase(url))) return undefined;

  const schema = `t_${label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${randomBytes(4).toString("hex")}`;
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  await admin.end({ timeout: 1 });

  const sql = connectDatabase(url, { schema, max: 4 });
  await migrate(sql);
  return {
    sql,
    schema,
    async reset() {
      await sql.unsafe(
        "TRUNCATE webhook_deliveries, faucet_grants, charges, hub_events, mandates, indexer_cursors, plans, merchant_payouts, merchants, support_circles, supporter_names, push_subscriptions, push_sent RESTART IDENTITY CASCADE",
      );
    },
    async close() {
      await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await sql.end({ timeout: 1 });
    },
  };
}
