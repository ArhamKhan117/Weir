/**
 * Analytics read from the Envio HyperIndex project (`apps/envio-indexer`), which indexes the hub
 * and the charger on every Monad network through HyperSync and keeps the aggregates a dashboard
 * wants: per merchant revenue, MRR and customers, per day volume, and what sent every charge.
 *
 * HyperIndex writes them to its own Postgres database; this reads that database directly, read
 * only, the same tables Envio's GraphQL API serves. Ids carry the chain (`10143-0xabc…`) and every
 * address is lowercase, as the indexer writes them.
 */

import type { ChargeTrigger, IndexedDay, MerchantAnalytics, NetworkStats } from "@weir/shared";
import postgres from "postgres";
import type { Address } from "viem";

type Sql = ReturnType<typeof postgres>;

const DAY = 86_400;
const WINDOW_DAYS = 30;

/** The last `WINDOW_DAYS` UTC days ending today, oldest first. */
export function windowDays(nowSeconds: number): { date: string; start: number }[] {
  const today = Math.floor(nowSeconds / DAY) * DAY;
  return Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const start = today - (WINDOW_DAYS - 1 - i) * DAY;
    return { date: new Date(start * 1000).toISOString().slice(0, 10), start };
  });
}

/** Rows summed per day into every day of the window, zero where nothing happened. */
export function fillDays(rows: readonly { dayStart: string; volume: string; charges: number; newMandates: number }[], nowSeconds: number): IndexedDay[] {
  const byDay = new Map<number, { volume: bigint; charges: number; newMandates: number }>();
  for (const row of rows) {
    const key = Number(row.dayStart);
    const day = byDay.get(key) ?? { volume: 0n, charges: 0, newMandates: 0 };
    day.volume += BigInt(row.volume);
    day.charges += row.charges;
    day.newMandates += row.newMandates;
    byDay.set(key, day);
  }
  return windowDays(nowSeconds).map(({ date, start }) => {
    const day = byDay.get(start);
    return { date, volume: (day?.volume ?? 0n).toString(), charges: day?.charges ?? 0, newMandates: day?.newMandates ?? 0 };
  });
}

export class EnvioAnalytics {
  constructor(private readonly sql: Sql) {}

  static connect(url: string): EnvioAnalytics {
    return new EnvioAnalytics(postgres(url, { max: 4, idle_timeout: 30, onnotice: () => undefined, connection: { default_transaction_read_only: true } }));
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 2 });
  }

  /** A business's figures, summed across every wallet it is paid to on `chainId`. */
  async merchant(chainId: number, addresses: readonly Address[], nowSeconds: number): Promise<MerchantAnalytics> {
    const ids = addresses.map((address) => `${chainId}-${address.toLowerCase()}`);
    const since = windowDays(nowSeconds)[0]?.start ?? 0;
    const [[totals], days, triggers] = await Promise.all([
      this.sql<{ mrr: string | null; revenue: string | null; customers: number | null; active: number | null; charges: number | null; failures: number | null }[]>`
        SELECT sum("mrr")::text AS mrr, sum("revenue")::text AS revenue, sum("customers")::int AS customers,
               sum("activeCustomers")::int AS active, sum("chargeCount")::int AS charges, sum("failureCount")::int AS failures
        FROM "Merchant" WHERE id IN ${this.sql(ids)}`,
      this.sql<{ dayStart: string; volume: string; charges: number; newMandates: number }[]>`
        SELECT "dayStart"::text AS "dayStart", "volume"::text AS volume, "charges", "newMandates"
        FROM "MerchantDailyStat" WHERE merchant_id IN ${this.sql(ids)} AND "dayStart" >= ${since}`,
      this.sql<{ trigger: ChargeTrigger; charges: number; volume: string }[]>`
        SELECT "trigger", count(*)::int AS charges, sum("amount")::text AS volume
        FROM "Charge" WHERE merchant_id IN ${this.sql(ids)} GROUP BY "trigger" ORDER BY sum("amount") DESC`,
    ]);
    return {
      chainId,
      mrr: totals?.mrr ?? "0",
      revenue: totals?.revenue ?? "0",
      customers: totals?.customers ?? 0,
      activeCustomers: totals?.active ?? 0,
      charges: totals?.charges ?? 0,
      failures: totals?.failures ?? 0,
      days: fillDays(days, nowSeconds),
      triggers,
    };
  }

  /** Every network the index holds, with its last 30 days. */
  async networks(nowSeconds: number): Promise<NetworkStats[]> {
    const since = windowDays(nowSeconds)[0]?.start ?? 0;
    const [networks, days] = await Promise.all([
      this.sql<
        {
          chainId: number;
          mandateCount: number;
          liveMandates: number;
          payerCount: number;
          merchantCount: number;
          chargeCount: number;
          volume: string;
          mrr: string;
          reportCount: number;
        }[]
      >`SELECT "chainId", "mandateCount", "liveMandates", "payerCount", "merchantCount", "chargeCount",
               "volume"::text AS volume, "mrr"::text AS mrr, "reportCount"
        FROM "Network" ORDER BY "chainId"`,
      this.sql<{ chainId: number; dayStart: string; volume: string; charges: number; newMandates: number }[]>`
        SELECT "chainId", "dayStart"::text AS "dayStart", "volume"::text AS volume, "charges", "newMandates"
        FROM "DailyStat" WHERE "dayStart" >= ${since}`,
    ]);
    return networks.map((n) => ({
      chainId: n.chainId,
      mandates: n.mandateCount,
      liveMandates: n.liveMandates,
      payers: n.payerCount,
      merchants: n.merchantCount,
      charges: n.chargeCount,
      volume: n.volume,
      mrr: n.mrr,
      reports: n.reportCount,
      days: fillDays(
        days.filter((d) => d.chainId === n.chainId),
        nowSeconds,
      ),
    }));
  }
}
