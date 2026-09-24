import { refFromString } from "@weir/shared";
import { getAddress, zeroAddress, type Address } from "viem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { silentLogger } from "../log.js";
import { openTestDatabase } from "../test/db.js";
import { ReminderWorker } from "./reminders.js";
import type { PushOutcome } from "./sender.js";

const hub = getAddress("0x00000000000000000000000000000000000000a1");
const asset = getAddress("0x00000000000000000000000000000000000000b1");
const merchant = getAddress("0x00000000000000000000000000000000000000c1");
const payer = getAddress("0x00000000000000000000000000000000000000d1");
const NOW = 1_800_000_000;
const DAY = 86_400;

const db = await openTestDatabase("reminders");

describe.skipIf(db === undefined)("push reminders", () => {
  const sql = db!.sql;
  const store = new Store(sql, { chainId: 10143, hub }, () => "tAUSD");
  let sent: { endpoint: string; payload: { title: string; body: string; tag: string } }[];
  let outcome: PushOutcome;

  const worker = () =>
    new ReminderWorker({
      store,
      logger: silentLogger,
      now: () => NOW,
      send: async (subscription, payload) => {
        sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as { title: string; body: string; tag: string } });
        return outcome;
      },
    });

  async function mandate(id: number, nextChargeAt: number, options: { status?: string; payTo?: Address } = {}): Promise<void> {
    await sql`
      INSERT INTO mandates (chain_id, hub, id, payer, merchant, asset, vault, manager, amount, period, next_charge_at,
                            max_per_charge, max_total, total_charged, expires_at, paused_at, status, ref,
                            created_at, created_block, created_tx, needs_refresh)
      VALUES (10143, ${hub}, ${id}, ${payer}, ${options.payTo ?? merchant}, ${asset}, ${zeroAddress}, ${zeroAddress}, 9990000,
              2592000, ${nextChargeAt}, 9990000, 119880000, 0, ${NOW + 365 * DAY}, 0, ${options.status ?? "Active"},
              ${refFromString("none")}, ${NOW - DAY}, ${id}, ${`0x${String(id).padStart(64, "0")}`}, false)`;
  }

  let events = 0;
  async function failedCharge(id: number, reason: number, blockTime: number): Promise<void> {
    events += 1;
    const tx = `0x${String(900 + events).padStart(64, "0")}`;
    await sql`INSERT INTO hub_events (chain_id, hub, tx_hash, log_index, block_number, block_hash, block_time, event, mandate_id, args)
              VALUES (10143, ${hub}, ${tx}, 0, ${100 + id}, '0x00', ${blockTime}, 'ChargeFailed', ${id}, '{}')`;
    await sql`INSERT INTO charges (chain_id, hub, tx_hash, log_index, block_number, block_time, mandate_id, kind, amount, reason)
              VALUES (10143, ${hub}, ${tx}, 0, ${100 + id}, ${blockTime}, ${id}, 'failed', 9990000, ${reason})`;
  }

  beforeEach(async () => {
    await db!.reset();
    sent = [];
    outcome = "sent";
    await store.savePushSubscription(payer, { endpoint: "https://push.example/a", p256dh: "p".repeat(87), auth: "a".repeat(22) }, NOW);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("reminds the day before a charge, once", async () => {
    await mandate(1, NOW + DAY - 60);
    // Too far off, already cancelled, and not this payer's device's business: none of these.
    await mandate(2, NOW + 3 * DAY);
    await mandate(3, NOW + 3_600, { status: "Cancelled" });

    expect(await worker().runOnce()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ title: "A payment: $9.99 tomorrow", tag: "upcoming-1" });
    expect(sent[0]?.payload.body).toMatch(/in about 24 hours/);

    // A second pass, or a second worker, sends nothing more.
    expect(await worker().runOnce()).toBe(0);
  });

  it("tells the payer at once when a charge fails, and never replays old failures", async () => {
    await mandate(4, NOW + 20 * DAY, { status: "Delinquent" });
    await failedCharge(4, 1, NOW - 60);
    await failedCharge(4, 3, NOW - 2 * 3_600);

    expect(await worker().runOnce()).toBe(1);
    expect(sent[0]?.payload).toMatchObject({ title: "A payment could not be paid", tag: "failed-4" });
    expect(sent[0]?.payload.body).toMatch(/balance is too low/);
  });

  it("forgets a browser the push service says is gone", async () => {
    await mandate(5, NOW + 3_600);
    outcome = "gone";
    await worker().runOnce();
    expect(await store.pushSubscriptionsFor(payer)).toEqual([]);
  });
});
