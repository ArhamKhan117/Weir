import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openTestDatabase, type TestDatabase } from "../test/db.js";
import { EnvioAnalytics, fillDays, windowDays } from "./envio.js";

const DAY = 86_400;
// Noon on 6 October 2026, UTC.
const NOW = 1_791_288_000;
const TODAY = Math.floor(NOW / DAY) * DAY;

describe("the 30-day window", () => {
  it("runs oldest first to today, one entry per UTC day", () => {
    const days = windowDays(NOW);
    expect(days).toHaveLength(30);
    expect(days.at(-1)).toEqual({ date: "2026-10-06", start: TODAY });
    expect(days[0]).toEqual({ date: "2026-09-07", start: TODAY - 29 * DAY });
  });

  it("sums rows of the same day and fills quiet days with zero", () => {
    const days = fillDays(
      [
        { dayStart: String(TODAY), volume: "5000000", charges: 1, newMandates: 1, meteredVolume: "3000", meterSettlements: 1 },
        { dayStart: String(TODAY), volume: "2500000", charges: 2, newMandates: 0, meteredVolume: "2000", meterSettlements: 1 },
        { dayStart: String(TODAY - 2 * DAY), volume: "100", charges: 1, newMandates: 3, meteredVolume: "0", meterSettlements: 0 },
        // Outside the window: ignored.
        { dayStart: String(TODAY - 40 * DAY), volume: "999", charges: 9, newMandates: 9, meteredVolume: "999", meterSettlements: 9 },
      ],
      NOW,
    );
    expect(days.at(-1)).toEqual({ date: "2026-10-06", volume: "7500000", charges: 3, newMandates: 1, meteredVolume: "5000", meterSettlements: 2 });
    expect(days.at(-2)).toEqual({ date: "2026-10-05", volume: "0", charges: 0, newMandates: 0, meteredVolume: "0", meterSettlements: 0 });
    expect(days.at(-3)).toMatchObject({ volume: "100", newMandates: 3 });
    expect(days.reduce((sum, d) => sum + d.charges, 0)).toBe(4);
  });
});

// The tables as Envio HyperIndex writes them (the columns these queries read), in a schema of the
// test database's own.
const db: TestDatabase | undefined = await openTestDatabase("envio");

describe.skipIf(db === undefined)("reading Envio HyperIndex", () => {
  const merchantA = "0x00000000000000000000000000000000000000aa";
  const merchantB = "0x00000000000000000000000000000000000000bb";
  let analytics: EnvioAnalytics;

  beforeAll(async () => {
    const sql = db!.sql;
    await sql.unsafe(`
      CREATE TABLE "Merchant" (id text PRIMARY KEY, "chainId" integer, address text, mrr numeric, revenue numeric,
        customers integer, "activeCustomers" integer, "chargeCount" integer, "failureCount" integer,
        "meteredRevenue" numeric, "meterSettlements" integer, "meterCount" integer, "liveMeters" integer);
      CREATE TABLE "MerchantDailyStat" (id text PRIMARY KEY, "chainId" integer, merchant_id text, date text, "dayStart" numeric,
        volume numeric, charges integer, "newMandates" integer, "meteredVolume" numeric, "meterSettlements" integer);
      CREATE TABLE "Charge" (id text PRIMARY KEY, "chainId" integer, merchant_id text, amount numeric, trigger text);
      CREATE TABLE "Network" (id text PRIMARY KEY, "chainId" integer, "mandateCount" integer, "liveMandates" integer,
        "payerCount" integer, "merchantCount" integer, "chargeCount" integer, volume numeric, mrr numeric, "reportCount" integer,
        "meterCount" integer, "liveMeters" integer, "meterPayerCount" integer, "meterSettlementCount" integer, "meteredVolume" numeric);
      CREATE TABLE "DailyStat" (id text PRIMARY KEY, "chainId" integer, date text, "dayStart" numeric, volume numeric,
        charges integer, "newMandates" integer, "meteredVolume" numeric, "meterSettlements" integer);
    `);
    await sql.unsafe(`
      INSERT INTO "Merchant" VALUES
        ('10143-${merchantA}', 10143, '${merchantA}', 9990000, 29970000, 3, 2, 3, 1, 11000, 2, 2, 1),
        ('10143-${merchantB}', 10143, '${merchantB}', 5000000, 5000000, 1, 1, 1, 0, 0, 0, 0, 0),
        ('143-${merchantA}', 143, '${merchantA}', 777, 777, 7, 7, 7, 7, 1, 1, 1, 1);
      INSERT INTO "MerchantDailyStat" VALUES
        ('a1', 10143, '10143-${merchantA}', '2026-10-06', ${TODAY}, 19980000, 2, 2, 11000, 2),
        ('b1', 10143, '10143-${merchantB}', '2026-10-06', ${TODAY}, 5000000, 1, 1, 0, 0),
        ('a0', 10143, '10143-${merchantA}', '2026-10-04', ${TODAY - 2 * DAY}, 9990000, 1, 1, 0, 0),
        ('m1', 143, '143-${merchantA}', '2026-10-06', ${TODAY}, 777, 7, 7, 1, 1);
      INSERT INTO "Charge" VALUES
        ('c1', 10143, '10143-${merchantA}', 9990000, 'Cre'),
        ('c2', 10143, '10143-${merchantA}', 19980000, 'Keeper'),
        ('c3', 10143, '10143-${merchantB}', 5000000, 'Keeper'),
        ('c4', 143, '143-${merchantA}', 777, 'Direct');
      INSERT INTO "Network" VALUES
        ('143', 143, 4, 0, 1, 1, 4, 303200, 0, 0, 1, 0, 1, 1, 20000),
        ('10143', 10143, 11, 3, 5, 4, 14, 80045000, 9990000, 1, 4, 1, 3, 5, 214000);
      INSERT INTO "DailyStat" VALUES
        ('143-d', 143, '2026-10-03', ${TODAY - 3 * DAY}, 303200, 4, 4, 0, 0),
        ('10143-d', 10143, '2026-10-06', ${TODAY}, 60000000, 3, 2, 214000, 5);
    `);
    analytics = new EnvioAnalytics(sql);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("sums a business across every wallet it is paid to, on its own network only", async () => {
    const result = await analytics.merchant(10143, [merchantA, merchantB.toUpperCase().replace("0X", "0x") as `0x${string}`], NOW);
    expect(result).toMatchObject({ chainId: 10143, mrr: "14990000", revenue: "34970000", customers: 4, activeCustomers: 3, charges: 4, failures: 1 });
    expect(result.days.at(-1)).toEqual({ date: "2026-10-06", volume: "24980000", charges: 3, newMandates: 3, meteredVolume: "11000", meterSettlements: 2 });
    // Pay per request is kept apart: it is not in revenue.
    expect(result.metered).toEqual({ revenue: "11000", settlements: 2, meters: 2, liveMeters: 1 });
    expect(result.days.at(-3)).toMatchObject({ volume: "9990000" });
    expect(result.triggers).toEqual([
      { trigger: "Keeper", charges: 2, volume: "24980000" },
      { trigger: "Cre", charges: 1, volume: "9990000" },
    ]);
  });

  it("answers zeros for a business the index has not seen", async () => {
    const result = await analytics.merchant(10143, ["0x00000000000000000000000000000000000000cc"], NOW);
    expect(result).toMatchObject({ mrr: "0", revenue: "0", customers: 0, charges: 0, triggers: [], metered: { revenue: "0", settlements: 0, meters: 0, liveMeters: 0 } });
    expect(result.days.every((d) => d.volume === "0")).toBe(true);
  });

  it("serves every network with its own days", async () => {
    const networks = await analytics.networks(NOW);
    expect(networks.map((n) => n.chainId)).toEqual([143, 10143]);
    expect(networks[0]).toMatchObject({ mandates: 4, charges: 4, volume: "303200", reports: 0 });
    expect(networks[1]).toMatchObject({ mandates: 11, liveMandates: 3, payers: 5, merchants: 4, reports: 1, mrr: "9990000" });
    expect(networks[0]?.days.at(-4)).toMatchObject({ volume: "303200", charges: 4 });
    expect(networks[1]?.days.at(-1)).toMatchObject({ volume: "60000000", meteredVolume: "214000", meterSettlements: 5 });
    expect(networks[1]?.metered).toEqual({ meters: 4, liveMeters: 1, payers: 3, settlements: 5, volume: "214000" });
    expect(networks[0]?.metered).toEqual({ meters: 1, liveMeters: 0, payers: 1, settlements: 1, volume: "20000" });
  });
});
