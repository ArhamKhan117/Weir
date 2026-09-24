import { mandateHubAbi, refFromString, type MandateRecord } from "@weir/shared";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  zeroAddress,
  type AbiEvent,
  type Hex,
} from "viem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { silentLogger } from "../log.js";
import { openTestDatabase } from "../test/db.js";
import type { RawLog, WatchedEvent } from "./events.js";
import { Indexer } from "./indexer.js";
import type { MandateReader } from "./reader.js";
import type { LogBatch, LogSource } from "./sources.js";

const hub = getAddress("0x00000000000000000000000000000000000000a1");
const asset = getAddress("0x00000000000000000000000000000000000000b1");
const payer = getAddress("0x00000000000000000000000000000000000000d1");
const merchant = getAddress("0x00000000000000000000000000000000000000e1");
const manager = getAddress("0x00000000000000000000000000000000000000f1");
const scope = { chainId: 10143, hub };
const T0 = 1_800_000_000;
const blockTime = (block: number): number => T0 + block;

const hex32 = (n: number, salt = 0): Hex => `0x${(n + salt * 1_000_000).toString(16).padStart(64, "0")}`;

function encode(eventName: WatchedEvent, args: Record<string, unknown>, at: { block: number; tx: number; index: number; fork?: number }): RawLog {
  const event = getAbiItem({ abi: mandateHubAbi, name: eventName }) as AbiEvent;
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never) as Hex[];
  const inputs = event.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(inputs, inputs.map((input) => args[input.name ?? ""]) as never);
  return {
    blockNumber: at.block,
    blockHash: hex32(at.block, at.fork ?? 0),
    transactionHash: hex32(at.tx + 500),
    logIndex: at.index,
    address: hub,
    topics,
    data,
  };
}

const created = (id: bigint, at: { block: number; tx: number; index: number }, ref: Hex = refFromString("pln_aaaaaaaaaaaaaaaa")) =>
  encode(
    "MandateCreated",
    {
      mandateId: id,
      payer,
      merchant,
      asset,
      vault: zeroAddress,
      manager: zeroAddress,
      amount: 5_000_000n,
      period: 2_592_000,
      nextChargeAt: BigInt(blockTime(at.block)),
      maxPerCharge: 5_000_000n,
      maxTotal: 60_000_000n,
      expiresAt: BigInt(T0 + 31_536_000),
      ref,
    },
    at,
  );

class FakeRpc {
  readonly name = "rpc" as const;
  readonly chunkBlocks = 100;
  logs: RawLog[] = [];
  headBlock = 0;
  reads: [number, number][] = [];
  /** Canonical hashes that differ from the default, for blocks a reorganisation replaced. */
  readonly replaced = new Map<number, Hex>();
  async head(): Promise<number> {
    return this.headBlock;
  }
  async getLogs(from: number, to: number): Promise<LogBatch> {
    this.reads.push([from, to]);
    return { logs: this.logs.filter((log) => log.blockNumber >= from && log.blockNumber <= to), blockTimes: new Map() };
  }
  async blockTime(block: number): Promise<number> {
    return blockTime(block);
  }
  async blockHash(block: number): Promise<Hex | undefined> {
    return block > this.headBlock ? undefined : (this.replaced.get(block) ?? hex32(block));
  }
}

class FakeReader implements MandateReader {
  readonly records = new Map<bigint, MandateRecord>();
  getMandate: MandateReader["getMandate"] = async (id) => this.records.get(id);
}

const chainState = (id: bigint, patch: Partial<MandateRecord> = {}): MandateRecord => ({
  id,
  payer,
  merchant,
  asset,
  vault: zeroAddress,
  manager: zeroAddress,
  amount: 5_000_000n,
  period: 2_592_000,
  nextChargeAt: BigInt(T0 + 2_592_000),
  maxPerCharge: 5_000_000n,
  maxTotal: 60_000_000n,
  totalCharged: 0n,
  expiresAt: BigInt(T0 + 31_536_000),
  pausedAt: 0n,
  status: "Active",
  ...patch,
});

const db = await openTestDatabase("indexer");

describe.skipIf(db === undefined)("the indexer", () => {
  const sql = db!.sql;
  let rpc: FakeRpc;
  let reader: FakeReader;
  let indexer: Indexer;

  const build = (hypersync?: LogSource) =>
    new Indexer({
      sql,
      scope,
      startBlock: 1,
      rpc,
      ...(hypersync === undefined ? {} : { hypersync }),
      reader,
      symbolFor: () => "tAUSD",
      logger: silentLogger,
      reorgWindowBlocks: 3,
      liveWindowBlocks: 50,
    });

  beforeEach(async () => {
    await db!.reset();
    rpc = new FakeRpc();
    reader = new FakeReader();
    indexer = build();
  });

  afterAll(async () => {
    await db?.close();
  });

  const mandateRow = async (id: number) => {
    const [row] = await sql<Record<string, unknown>[]>`SELECT * FROM mandates WHERE chain_id = ${scope.chainId} AND hub = ${hub} AND id = ${id}`;
    return row;
  };
  const count = async (table: "hub_events" | "charges" | "webhook_deliveries"): Promise<number> =>
    Number((await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0]?.n);

  it("applies every event, then refreshes each touched row from getMandate", async () => {
    rpc.logs = [
      created(1n, { block: 5, tx: 1, index: 0 }),
      encode("Charged", { mandateId: 1n, merchant, amount: 5_000_000n, totalCharged: 5_000_000n, nextChargeAt: BigInt(T0 + 2_592_000) }, { block: 6, tx: 2, index: 0 }),
      encode("ChargeFailed", { mandateId: 1n, reason: 1, required: 5_000_000n }, { block: 7, tx: 3, index: 0 }),
      encode("ManagerChanged", { mandateId: 1n, manager }, { block: 8, tx: 4, index: 0 }),
      encode("MandateCancelled", { mandateId: 1n, by: payer }, { block: 9, tx: 5, index: 1 }),
    ];
    rpc.headBlock = 12;
    reader.records.set(1n, chainState(1n, { manager, totalCharged: 5_000_000n, status: "Cancelled" }));

    const report = await indexer.tick();
    expect(report).toMatchObject({ fromBlock: 1, toBlock: 12, inserted: 5, removed: 0, refreshed: 1, caughtUp: true, source: "rpc" });

    const row = await mandateRow(1);
    expect(row).toMatchObject({
      payer,
      merchant,
      manager,
      total_charged: "5000000",
      status: "Cancelled",
      needs_refresh: false,
      created_block: "5",
      created_at: String(blockTime(5)),
      ref: refFromString("pln_aaaaaaaaaaaaaaaa"),
    });
    const charges = await sql`SELECT kind, amount, reason, block_time FROM charges ORDER BY block_number`;
    expect(charges.map((c) => [c.kind, c.amount, c.reason, Number(c.block_time)])).toEqual([
      ["charged", "5000000", null, blockTime(6)],
      ["failed", "5000000", 1, blockTime(7)],
    ]);
    expect(indexer.status).toMatchObject({ head: 12, indexedBlock: 12, lag: 0, caughtUp: true });
  });

  it("stores the chain's state even where the event does not carry it", async () => {
    rpc.logs = [
      created(1n, { block: 2, tx: 1, index: 0 }),
      encode("MandatePaused", { mandateId: 1n, by: payer }, { block: 3, tx: 2, index: 0 }),
      encode("MandateResumed", { mandateId: 1n, by: payer }, { block: 4, tx: 3, index: 0 }),
    ];
    rpc.headBlock = 4;
    // A resume shifts the checkpoint by the paused time; only getMandate says by how much.
    reader.records.set(1n, chainState(1n, { period: 0, nextChargeAt: BigInt(T0 + 77) }));
    await indexer.tick();
    expect(await mandateRow(1)).toMatchObject({ paused_at: "0", next_charge_at: String(T0 + 77), period: 0 });
  });

  it("is idempotent: reading the same blocks again writes and queues nothing new", async () => {
    await sql`INSERT INTO merchants (id, auth_subject, name, payout_address, webhook_url, webhook_since, webhook_secret, created_at)
              VALUES ('mer_a', 'dev:a', 'A', ${merchant}, 'https://a.example/hooks', 0, 'whsec_a', 0)`;
    await sql`INSERT INTO merchant_payouts (merchant_id, address, added_at) VALUES ('mer_a', ${merchant}, 0)`;
    rpc.logs = [created(1n, { block: 2, tx: 1, index: 0 }), encode("Charged", { mandateId: 1n, merchant, amount: 1n, totalCharged: 1n, nextChargeAt: 9n }, { block: 3, tx: 2, index: 0 })];
    rpc.headBlock = 3;
    reader.records.set(1n, chainState(1n));

    expect((await indexer.tick()).inserted).toBe(2);
    expect(await count("webhook_deliveries")).toBe(2);
    // Every later tick re-reads the tip, and a restart from an earlier cursor re-reads everything.
    expect((await indexer.tick()).inserted).toBe(0);
    await sql`UPDATE indexer_cursors SET last_block = 0`;
    const again = await indexer.tick();
    expect(again).toMatchObject({ fromBlock: 1, inserted: 0, removed: 0 });
    expect(await count("hub_events")).toBe(2);
    expect(await count("charges")).toBe(1);
    expect(await count("webhook_deliveries")).toBe(2);
  });

  it("removes what a reorganisation took away, and moves what it re-mined", async () => {
    const charge = encode("Charged", { mandateId: 1n, merchant, amount: 1n, totalCharged: 1n, nextChargeAt: 9n }, { block: 9, tx: 2, index: 0 });
    const cancel = encode("MandateCancelled", { mandateId: 1n, by: payer }, { block: 10, tx: 3, index: 0 });
    rpc.logs = [created(1n, { block: 2, tx: 1, index: 0 }), charge, cancel];
    rpc.headBlock = 10;
    reader.records.set(1n, chainState(1n, { status: "Cancelled", totalCharged: 1n }));
    await indexer.tick();
    expect(await count("charges")).toBe(1);

    // The tip re-orgs: the cancel never happened and the charge landed one block later.
    rpc.logs = [created(1n, { block: 2, tx: 1, index: 0 }), { ...charge, blockNumber: 10, blockHash: hex32(10, 7) }];
    rpc.replaced.set(9, hex32(9, 7));
    rpc.replaced.set(10, hex32(10, 7));
    rpc.headBlock = 11;
    reader.records.set(1n, chainState(1n, { totalCharged: 1n }));
    const report = await indexer.tick();
    expect(report).toMatchObject({ fromBlock: 9, toBlock: 11, removed: 1, inserted: 0 });
    expect(await count("hub_events")).toBe(2);
    const [moved] = await sql`SELECT block_number FROM charges`;
    expect(moved?.block_number).toBe("10");
    expect(await mandateRow(1)).toMatchObject({ status: "Active", needs_refresh: false });
  });

  it("deletes a mandate whose creation a reorganisation removed", async () => {
    rpc.logs = [created(1n, { block: 9, tx: 1, index: 0 })];
    rpc.headBlock = 10;
    reader.records.set(1n, chainState(1n));
    await indexer.tick();
    expect(await mandateRow(1)).toBeDefined();
    rpc.logs = [];
    rpc.replaced.set(9, hex32(9, 7));
    rpc.headBlock = 11;
    await indexer.tick();
    expect(await mandateRow(1)).toBeUndefined();
  });

  it("keeps what a lagging backend left out, when the chain still has its block", async () => {
    rpc.logs = [created(1n, { block: 9, tx: 1, index: 0 }), encode("Charged", { mandateId: 1n, merchant, amount: 1n, totalCharged: 1n, nextChargeAt: 9n }, { block: 10, tx: 2, index: 0 })];
    rpc.headBlock = 10;
    reader.records.set(1n, chainState(1n, { totalCharged: 1n }));
    await indexer.tick();

    // A backend behind the head answers eth_getLogs with an empty list rather than an error.
    const lagging = rpc.logs;
    rpc.logs = [];
    rpc.headBlock = 11;
    expect(await indexer.tick()).toMatchObject({ removed: 0 });
    expect(await count("hub_events")).toBe(2);
    expect(await mandateRow(1)).toMatchObject({ total_charged: "1" });
    rpc.logs = lagging;
    expect(await indexer.tick()).toMatchObject({ removed: 0, inserted: 0 });
  });

  it("refreshes at the indexed block, and defers a read the node cannot serve yet", async () => {
    const asked: (number | undefined)[] = [];
    let refuse = true;
    reader.getMandate = async (id, block) => {
      asked.push(block);
      if (refuse) throw new Error("Block requested not found");
      return chainState(id, { status: "Delinquent" });
    };
    rpc.logs = [created(1n, { block: 2, tx: 1, index: 0 })];
    rpc.headBlock = 7;
    expect((await indexer.tick()).refreshed).toBe(0);
    expect(await mandateRow(1)).toMatchObject({ needs_refresh: true });
    refuse = false;
    rpc.headBlock = 8;
    expect((await indexer.tick()).refreshed).toBe(1);
    expect(asked).toEqual([7, 8]);
    expect(await mandateRow(1)).toMatchObject({ needs_refresh: false, status: "Delinquent" });
  });

  it("keeps a mandate marked until the node knows it", async () => {
    rpc.logs = [created(1n, { block: 2, tx: 1, index: 0 })];
    rpc.headBlock = 2;
    await indexer.tick();
    expect(await mandateRow(1)).toMatchObject({ needs_refresh: true, status: "Active" });
    reader.records.set(1n, chainState(1n, { status: "Delinquent" }));
    expect((await indexer.tick()).refreshed).toBe(1);
    expect(await mandateRow(1)).toMatchObject({ needs_refresh: false, status: "Delinquent" });
  });

  it("queues each webhook event for the merchant paid, with the plan and a signed-off body", async () => {
    await sql`INSERT INTO merchants (id, auth_subject, name, payout_address, webhook_url, webhook_since, webhook_secret, created_at) VALUES
              ('mer_a', 'dev:a', 'Acme', ${merchant}, 'https://a.example/hooks', ${blockTime(3)}, 'whsec_a', 0),
              ('mer_b', 'dev:b', 'Other', ${payer}, 'https://b.example/hooks', 0, 'whsec_b', 0),
              ('mer_c', 'dev:c', 'Quiet', ${merchant}, NULL, NULL, 'whsec_c', 0)`;
    await sql`INSERT INTO merchant_payouts (merchant_id, address, added_at) VALUES ('mer_a', ${merchant}, 0), ('mer_b', ${payer}, 0), ('mer_c', ${merchant}, 0)`;
    await sql`INSERT INTO plans (id, chain_id, merchant_id, ref, name, description, asset, mode, amount, period, trial_days, max_per_charge, max_total, term_seconds, created_at)
              VALUES ('pln_aaaaaaaaaaaaaaaa', ${scope.chainId}, 'mer_a', ${refFromString("pln_aaaaaaaaaaaaaaaa")}, 'Pro', 'Everything', ${asset}, 'periodic', 5000000, 2592000, 0, 5000000, 60000000, 31536000, 0)`;
    rpc.logs = [
      // Before mer_a set its webhook: not replayed at it.
      created(1n, { block: 2, tx: 1, index: 0 }),
      created(2n, { block: 3, tx: 2, index: 0 }),
      encode("ManagerChanged", { mandateId: 2n, manager }, { block: 4, tx: 3, index: 0 }),
      encode("ChargeFailed", { mandateId: 2n, reason: 2, required: 5_000_000n }, { block: 5, tx: 4, index: 3 }),
    ];
    rpc.headBlock = 5;
    reader.records.set(1n, chainState(1n));
    reader.records.set(2n, chainState(2n));
    const report = await indexer.tick();
    expect(report.deliveries).toBe(2);

    const rows = await sql<{ merchant_id: string; event_type: string; event_id: string; body: string }[]>`
      SELECT merchant_id, event_type, event_id, body FROM webhook_deliveries ORDER BY id`;
    expect(rows.map((row) => [row.merchant_id, row.event_type])).toEqual([
      ["mer_a", "mandate.created"],
      ["mer_a", "charge.failed"],
    ]);
    const failed = JSON.parse(rows[1]!.body) as Record<string, unknown> & { data: Record<string, Record<string, unknown>> };
    expect(failed).toMatchObject({ id: `evt_10143_${hex32(504)}_3`, type: "charge.failed", createdAt: blockTime(5), chainId: 10143 });
    expect(failed.data.charge).toMatchObject({ kind: "failed", amount: "5000000", reason: 2, payer, merchant, asset, mandateId: "2" });
    expect(failed.data.mandate).toMatchObject({ id: "2", status: "Delinquent", standing: "Past due", manager, plan: { id: "pln_aaaaaaaaaaaaaaaa", name: "Pro", merchantName: "Acme" } });
  });

  it("catches up from HyperSync far behind the head and reads the tip from the RPC", async () => {
    const calls: [number, number][] = [];
    const archive: LogSource = {
      name: "hypersync",
      async getLogs(from, to) {
        calls.push([from, to]);
        return { logs: [created(1n, { block: 400, tx: 1, index: 0 })].filter((l) => l.blockNumber >= from && l.blockNumber <= to), blockTimes: new Map([[400, 42]]) };
      },
    };
    indexer = build(archive);
    rpc.headBlock = 1_000;
    reader.records.set(1n, chainState(1n));

    const first = await indexer.tick();
    expect(first).toMatchObject({ source: "hypersync", fromBlock: 1, toBlock: 950, inserted: 1 });
    expect(calls).toEqual([[1, 950]]);
    expect(await mandateRow(1)).toMatchObject({ created_at: "42" });
    const second = await indexer.tick();
    expect(second).toMatchObject({ source: "rpc", fromBlock: 951, toBlock: 1_000, caughtUp: true });
  });

  it("falls back to the RPC when HyperSync fails, and rests it", async () => {
    const archive: LogSource = {
      name: "hypersync",
      async getLogs() {
        throw new Error("401 unauthorized");
      },
    };
    indexer = build(archive);
    rpc.headBlock = 1_000;
    const report = await indexer.tick();
    expect(report).toMatchObject({ source: "rpc", fromBlock: 1, toBlock: 100 });
    expect((await indexer.tick()).source).toBe("rpc");
  });
});
