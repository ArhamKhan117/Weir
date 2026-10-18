/**
 * The handlers end to end on simulated events: the real `config.yaml`, schema and handlers, run
 * by Envio's test indexer with no network. The expiry sweep's one RPC read is answered by a stub
 * that dates block `n` to `T0 + (n - START)`.
 */

import { createTestIndexer, type Address, type Mandate, type Meter, type TestIndexer } from "envio";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isLive, isMeterLive, type MeterStanding, type Standing } from "../src/model.js";
import { NETWORKS, REVERT_REASONS } from "../src/networks.js";

const CHAIN = 10143;
const NETWORK = NETWORKS[CHAIN]!;
const START = NETWORK.startBlock;
const T0 = 1_790_000_000;
const at = (block: number) => T0 + (block - START);

const HUB = NETWORK.hub as Address;
const METER = NETWORK.meter as Address;
const METER_START = NETWORK.meterStartBlock;
const CHARGER = NETWORK.charger as Address;
const SIMULATION_FORWARDER = NETWORK.simulationForwarder as Address;
const PAYER: Address = "0x00000000000000000000000000000000000000a1";
const OTHER_PAYER: Address = "0x00000000000000000000000000000000000000a2";
const MERCHANT: Address = "0x00000000000000000000000000000000000000b1";
const KEEPER: Address = "0x00000000000000000000000000000000000000c1";
const RELAYER: Address = "0x00000000000000000000000000000000000000c2";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const TAUSD = Object.entries(NETWORK.assets).find(([, symbol]) => symbol === "tAUSD")![0] as Address;
const NOT_DUE = Object.entries(REVERT_REASONS).find(([, error]) => error.startsWith("NotDue("))![0];

const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const id = (mandateId: number) => `${CHAIN}-${mandateId}`;
const account = (address: string) => `${CHAIN}-${address}`;

function created(block: number, mandateId: number, terms: { payer?: Address; amount: bigint; period: number; maxTotal: bigint; maxPerCharge?: bigint; expiresIn: number; startsIn?: number }) {
  return {
    contract: "MandateHub" as const,
    event: "MandateCreated" as const,
    block: { number: block, timestamp: at(block) },
    transaction: { hash: tx(block), from: RELAYER, to: HUB },
    params: {
      mandateId: BigInt(mandateId),
      payer: terms.payer ?? PAYER,
      merchant: MERCHANT,
      asset: TAUSD,
      vault: ZERO,
      manager: ZERO,
      amount: terms.amount,
      period: BigInt(terms.period),
      nextChargeAt: BigInt(at(block) + (terms.startsIn ?? 0)),
      maxPerCharge: terms.maxPerCharge ?? terms.amount,
      maxTotal: terms.maxTotal,
      expiresAt: BigInt(at(block) + terms.expiresIn),
      ref: `0x${"0".repeat(64)}`,
    },
  };
}

function charged(block: number, mandateId: number, amount: bigint, totalCharged: bigint, nextChargeAt: number, via: { to: Address; hash?: string; logIndex?: number }) {
  return {
    contract: "MandateHub" as const,
    event: "Charged" as const,
    block: { number: block, timestamp: at(block) },
    transaction: { hash: via.hash ?? tx(block), from: KEEPER, to: via.to },
    ...(via.logIndex === undefined ? {} : { logIndex: via.logIndex }),
    params: { mandateId: BigInt(mandateId), merchant: MERCHANT, amount, totalCharged, nextChargeAt: BigInt(nextChargeAt) },
  };
}

function fromBalance(block: number, mandateId: number, amount: bigint, via: { to: Address; hash?: string; logIndex?: number }) {
  return {
    contract: "MandateHub" as const,
    event: "ChargedFromBalance" as const,
    block: { number: block, timestamp: at(block) },
    transaction: { hash: via.hash ?? tx(block), from: KEEPER, to: via.to },
    ...(via.logIndex === undefined ? {} : { logIndex: via.logIndex }),
    params: { mandateId: BigInt(mandateId), amount },
  };
}

function failed(block: number, mandateId: number, reason: number, required: bigint, via: { to: Address; hash?: string; logIndex?: number }) {
  return {
    contract: "MandateHub" as const,
    event: "ChargeFailed" as const,
    block: { number: block, timestamp: at(block) },
    transaction: { hash: via.hash ?? tx(block), from: KEEPER, to: via.to },
    ...(via.logIndex === undefined ? {} : { logIndex: via.logIndex }),
    params: { mandateId: BigInt(mandateId), reason: BigInt(reason), required },
  };
}

function lifecycle<E extends "MandatePaused" | "MandateResumed" | "MandateCancelled">(event: E, block: number, mandateId: number, by: Address, logIndex?: number) {
  return {
    contract: "MandateHub" as const,
    event,
    block: { number: block, timestamp: at(block) },
    transaction: { hash: tx(block), from: RELAYER, to: HUB },
    ...(logIndex === undefined ? {} : { logIndex }),
    params: { mandateId: BigInt(mandateId), by },
  };
}

/**
 * Every aggregate against the mandates it sums: counts by standing, MRR, commitments and
 * customers must equal what the mandates themselves say.
 */
async function expectBalancedBooks(indexer: TestIndexer) {
  const mandates: Mandate[] = await indexer.Mandate.getAll();
  const network = await indexer.Network.getOrThrow(`${CHAIN}`);
  const count = (rows: Mandate[], standing: Standing) => rows.filter((m) => m.standing === standing).length;
  const sum = (rows: Mandate[], pick: (m: Mandate) => bigint) => rows.reduce((total, m) => total + pick(m), 0n);

  const expectCounts = (row: Record<string, unknown>, rows: Mandate[]) =>
    expect(row).toMatchObject({
      mandateCount: rows.length,
      activeMandates: count(rows, "Active"),
      pausedMandates: count(rows, "Paused"),
      pastDueMandates: count(rows, "PastDue"),
      completedMandates: count(rows, "Completed"),
      expiredMandates: count(rows, "Expired"),
      cancelledMandates: count(rows, "Cancelled"),
      liveMandates: rows.filter((m) => isLive(m.standing)).length,
    });

  expectCounts(network, mandates);
  expect(network.openMandates).toBe(mandates.filter((m) => !m.ended).length);
  expect(network.mrr).toBe(sum(mandates, (m) => m.mrr));

  for (const merchant of await indexer.Merchant.getAll()) {
    const theirs = mandates.filter((m) => m.merchant_id === merchant.id);
    expectCounts(merchant, theirs);
    expect(merchant.mrr).toBe(sum(theirs, (m) => m.mrr));
    expect(merchant.customers).toBe(new Set(theirs.map((m) => m.payer_id)).size);
    expect(merchant.activeCustomers).toBe(new Set(theirs.filter((m) => isLive(m.standing)).map((m) => m.payer_id)).size);
  }
  for (const payer of await indexer.Payer.getAll()) {
    const theirs = mandates.filter((m) => m.payer_id === payer.id);
    expectCounts(payer, theirs);
    expect(payer.committedMonthly).toBe(sum(theirs, (m) => m.committedMonthly));
    expect(payer.totalPaid).toBe(sum(theirs, (m) => m.totalCharged));
  }
}

beforeAll(() => {
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { method: string; params: [string, boolean] };
    if (request.method !== "eth_getBlockByNumber") throw new Error(`unexpected ${request.method}`);
    const block = Number(BigInt(request.params[0]));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { timestamp: `0x${at(block).toString(16)}` } }));
  });
});
afterAll(() => vi.unstubAllGlobals());

describe("MandateHub and MandateCharger handlers", () => {
  const indexer = createTestIndexer();

  it("follows a periodic mandate through a keeper charge, a failure, a direct charge and its cap", async () => {
    const b = START + 10;
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            created(b, 1, { amount: 5_000_000n, period: 60, maxTotal: 10_000_000n, expiresIn: 10_000 }),
            charged(b + 1, 1, 5_000_000n, 5_000_000n, at(b) + 60, { to: CHARGER }),
            failed(b + 2, 1, 1, 5_000_000n, { to: CHARGER }),
          ],
        },
      },
    });

    const behind = await indexer.Mandate.getOrThrow(id(1));
    expect(behind).toMatchObject({ standing: "PastDue", status: "Delinquent", mrr: 0n, chargeCount: 1, failureCount: 1 });
    // A mandate behind on payment is out of MRR but still in what its payer has committed.
    expect(behind.committedMonthly).toBe(216_000_000_000n);
    expect(behind.lastFailureReason).toBe("InsufficientBalance");
    const [charge] = await indexer.Charge.getAll();
    expect(charge).toMatchObject({ trigger: "Keeper", amount: 5_000_000n, sender: KEEPER, assetSymbol: "tAUSD" });
    await expectBalancedBooks(indexer);

    await indexer.process({
      chains: { [CHAIN]: { simulate: [charged(b + 3, 1, 5_000_000n, 10_000_000n, at(b) + 120, { to: HUB })] } },
    });
    const spent = await indexer.Mandate.getOrThrow(id(1));
    expect(spent).toMatchObject({ standing: "Completed", status: "Active", remaining: 0n, mrr: 0n, committedMonthly: 0n });
    const direct = (await indexer.Charge.getAll()).find((c) => c.blockNumber === b + 3);
    expect(direct?.trigger).toBe("Direct");
    expect(await indexer.Merchant.getOrThrow(account(MERCHANT))).toMatchObject({ revenue: 10_000_000n, chargeCount: 2, activeCustomers: 0 });
    await expectBalancedBooks(indexer);
  });

  it("marks a stream's settlement on pause, and moves its checkpoint on resume as the hub does", async () => {
    const b = START + 100;
    // The pause's settlement cannot be funded: the failure is the log right before the pause.
    const pauseTx = tx(b + 50);
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            created(b, 2, { payer: OTHER_PAYER, amount: 1_000n, period: 0, maxPerCharge: 1_000_000n, maxTotal: 10_000_000n, expiresIn: 1_000_000 }),
            failed(b + 50, 2, 1, 50_000n, { to: HUB, hash: pauseTx, logIndex: 7 }),
            { ...lifecycle("MandatePaused", b + 50, 2, OTHER_PAYER, 8), transaction: { hash: pauseTx, from: RELAYER, to: HUB } },
            lifecycle("MandateResumed", b + 250, 2, OTHER_PAYER),
          ],
        },
      },
    });

    const [failure] = (await indexer.ChargeFailure.getAll()).filter((f) => f.mandate_id === id(2));
    expect(failure?.trigger).toBe("Settlement");
    const stream = await indexer.Mandate.getOrThrow(id(2));
    // Checkpoint at creation, paused 50s later with nothing collected, resumed 200s after that:
    // the 200 paused seconds are skipped, the 50 before the pause stay owed.
    expect(stream.nextChargeAt).toBe(BigInt(at(b) + 200));
    expect(stream).toMatchObject({ pausedAt: 0n, pauseCount: 1, standing: "PastDue", mode: "Streaming", mrr: 0n, committedMonthly: 0n });
    await expectBalancedBooks(indexer);
  });

  it("links a CRE report to the charges, failures and reverts it caused", async () => {
    const b = START + 400;
    const reportTx = tx(b + 10);
    const via = (logIndex: number) => ({ to: SIMULATION_FORWARDER, hash: reportTx, logIndex });
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            created(b, 3, { amount: 9_990_000n, period: 2_592_000, maxTotal: 119_880_000n, expiresIn: 31_536_000 }),
            charged(b + 10, 3, 9_990_000n, 9_990_000n, at(b) + 2_592_000, via(1)),
            failed(b + 10, 2, 2, 7_000n, via(2)),
            {
              contract: "MandateCharger",
              event: "ChargeReverted",
              block: { number: b + 10, timestamp: at(b + 10) },
              transaction: { hash: reportTx, from: KEEPER, to: SIMULATION_FORWARDER },
              logIndex: 3,
              params: { mandateId: 3n, reason: NOT_DUE },
            },
            {
              contract: "MandateCharger",
              event: "ReportCharged",
              block: { number: b + 10, timestamp: at(b + 10) },
              transaction: { hash: reportTx, from: KEEPER, to: SIMULATION_FORWARDER },
              logIndex: 4,
              params: { workflowId: `0x${"ab".repeat(32)}`, forwarder: SIMULATION_FORWARDER, attempted: 3n, charged: 1n },
            },
          ],
        },
      },
    });

    const reportId = `${CHAIN}-${reportTx}-4`;
    const report = await indexer.ChargerReport.getOrThrow(reportId);
    expect(report).toMatchObject({ attempted: 3, charged: 1, failed: 1, reverted: 1, volume: 9_990_000n, simulated: true });
    const charge = await indexer.Charge.getOrThrow(`${CHAIN}-${reportTx}-1`);
    expect(charge).toMatchObject({ trigger: "Cre", report_id: reportId });
    expect(await indexer.ChargeFailure.getOrThrow(`${CHAIN}-${reportTx}-2`)).toMatchObject({ trigger: "Cre", report_id: reportId, reason: "InsufficientAllowance" });
    expect(await indexer.ChargeRevert.getOrThrow(`${CHAIN}-${reportTx}-3`)).toMatchObject({ trigger: "Cre", report_id: reportId, error: "NotDue(uint64,uint256)" });
    expect(await indexer.MerchantAsset.getOrThrow(`${CHAIN}-${MERCHANT}-${TAUSD}`)).toMatchObject({ mrr: 9_990_000n, activeMandates: 1, pastDueMandates: 1 });
    await expectBalancedBooks(indexer);
  });

  it("expires what has passed its expiry, with no event to say so, and dates it to its own day", async () => {
    // Mandate 1 expires at T0 + 10 + 10,000. The sweep runs on the pass after that, and a
    // last event past it closes the range.
    const b = START + 30_000;
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "MandateHub",
              event: "NonceInvalidated",
              block: { number: b, timestamp: at(b) },
              transaction: { hash: tx(b), from: PAYER, to: HUB },
              params: { signer: PAYER, nonce: 7n },
            },
          ],
        },
      },
    });

    const expired = await indexer.Mandate.getOrThrow(id(1));
    expect(expired).toMatchObject({ standing: "Expired", ended: true });
    const entry = await indexer.MandateEvent.getOrThrow(`${id(1)}-expired`);
    expect(entry.timestamp).toBe(expired.expiresAt + 1n);
    expect((await indexer.Mandate.getOrThrow(id(3))).standing).toBe("Active");
    const days = await indexer.DailyStat.getAll();
    expect(days.reduce((total, day) => total + day.expirations, 0)).toBe(1);
    expect(await indexer.NonceInvalidation.getAll()).toHaveLength(1);
    await expectBalancedBooks(indexer);
  });

  it("cancels, and a customer with nothing live stops counting as active", async () => {
    const b = START + 30_100;
    await indexer.process({ chains: { [CHAIN]: { simulate: [lifecycle("MandateCancelled", b, 3, MERCHANT)] } } });
    const cancelled = await indexer.Mandate.getOrThrow(id(3));
    expect(cancelled).toMatchObject({ standing: "Cancelled", cancelledBy: MERCHANT, mrr: 0n });
    const merchant = await indexer.Merchant.getOrThrow(account(MERCHANT));
    // Mandate 2's payer is still past due, so still a customer with something live.
    expect(merchant).toMatchObject({ customers: 2, activeCustomers: 1, mrr: 0n });
    await expectBalancedBooks(indexer);
  });

  it("marks a savings charge the balance paid, and no other", async () => {
    const b = START + 40_000;
    const hash = tx(b + 1);
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            created(b, 40, { amount: 5_000_000n, period: 60, maxTotal: 60_000_000n, expiresIn: 10_000 }),
            fromBalance(b + 1, 40, 5_000_000n, { to: CHARGER, hash, logIndex: 3 }),
            charged(b + 1, 40, 5_000_000n, 5_000_000n, at(b) + 60, { to: CHARGER, hash, logIndex: 4 }),
            charged(b + 2, 40, 5_000_000n, 10_000_000n, at(b) + 120, { to: CHARGER }),
          ],
        },
      },
    });

    const charges = (await indexer.Charge.getAll()).filter((c) => c.mandate_id === id(40));
    expect(charges.map((c) => [c.blockNumber, c.fromBalance])).toEqual([
      [b + 1, true],
      [b + 2, false],
    ]);
    expect(await indexer.Mandate.getOrThrow(id(40))).toMatchObject({ chargeCount: 2, totalCharged: 10_000_000n });
    await expectBalancedBooks(indexer);
  });
});

function meterCreated(block: number, meterId: number, terms: { payer?: Address; periodCap: bigint; period: number; maxTotal: bigint; expiresIn: number; manager?: Address }) {
  return {
    contract: "MandateMeter" as const,
    event: "MeterCreated" as const,
    block: { number: block, timestamp: at(block) },
    transaction: { hash: tx(block), from: RELAYER, to: METER },
    params: {
      meterId: BigInt(meterId),
      payer: terms.payer ?? PAYER,
      merchant: MERCHANT,
      asset: TAUSD,
      manager: terms.manager ?? ZERO,
      periodCap: terms.periodCap,
      period: BigInt(terms.period),
      maxTotal: terms.maxTotal,
      expiresAt: BigInt(at(block) + terms.expiresIn),
      ref: `0x${"0".repeat(64)}`,
    },
  };
}

function settled(block: number, meterId: number, amount: bigint, totalCharged: bigint, receiptTotal: bigint) {
  return {
    contract: "MandateMeter" as const,
    event: "UsageSettled" as const,
    block: { number: block, timestamp: at(block) },
    transaction: { hash: tx(block), from: RELAYER, to: METER },
    params: { meterId: BigInt(meterId), merchant: MERCHANT, amount, totalCharged, receiptTotal },
  };
}

function settleFailed(block: number, meterId: number, reason: number, required: bigint) {
  return {
    contract: "MandateMeter" as const,
    event: "SettleFailed" as const,
    block: { number: block, timestamp: at(block) },
    transaction: { hash: tx(block), from: RELAYER, to: METER },
    params: { meterId: BigInt(meterId), reason: BigInt(reason), required },
  };
}

/**
 * Every meter aggregate against the meters and settlements it sums, and the mandate counts on the
 * network against the mandates, so a party first seen through a meter is counted right.
 */
async function expectBalancedMeters(indexer: TestIndexer) {
  const meters: Meter[] = await indexer.Meter.getAll();
  const settlements = await indexer.MeterSettlement.getAll();
  const failures = await indexer.MeterSettleFailure.getAll();
  const mandates: Mandate[] = await indexer.Mandate.getAll();
  const network = await indexer.Network.getOrThrow(`${CHAIN}`);
  const count = (rows: Meter[], standing: MeterStanding) => rows.filter((m) => m.standing === standing).length;
  const paid = (rows: { amount: bigint }[]) => rows.reduce((total, row) => total + row.amount, 0n);

  const expectCounts = (row: Record<string, unknown>, rows: Meter[]) =>
    expect(row).toMatchObject({
      meterCount: rows.length,
      activeMeters: count(rows, "Active"),
      pastDueMeters: count(rows, "PastDue"),
      completedMeters: count(rows, "Completed"),
      expiredMeters: count(rows, "Expired"),
      cancelledMeters: count(rows, "Cancelled"),
      liveMeters: rows.filter((m) => isMeterLive(m.standing)).length,
    });

  expectCounts(network, meters);
  expect(network).toMatchObject({
    openMeters: meters.filter((m) => !m.ended).length,
    meterSettlementCount: settlements.length,
    meterFailureCount: failures.length,
    meteredVolume: paid(settlements),
    meterMerchantCount: new Set(meters.map((m) => m.merchant_id)).size,
    meterPayerCount: new Set(meters.map((m) => m.payer_id)).size,
    merchantCount: new Set(mandates.map((m) => m.merchant_id)).size,
    payerCount: new Set(mandates.map((m) => m.payer_id)).size,
  });
  for (const meter of meters) {
    const own = settlements.filter((s) => s.meter_id === meter.id);
    expect(meter).toMatchObject({ totalCharged: paid(own), settlementCount: own.length, remaining: meter.maxTotal - meter.totalCharged });
  }
  for (const merchant of await indexer.Merchant.getAll()) {
    expectCounts(merchant, meters.filter((m) => m.merchant_id === merchant.id));
    const own = settlements.filter((s) => s.merchant_id === merchant.id);
    expect(merchant).toMatchObject({ meteredRevenue: paid(own), meterSettlements: own.length });
  }
  for (const payer of await indexer.Payer.getAll()) {
    expectCounts(payer, meters.filter((m) => m.payer_id === payer.id));
    expect(payer.meteredPaid).toBe(paid(settlements.filter((s) => s.payer_id === payer.id)));
  }
  const days = await indexer.DailyStat.getAll();
  expect(days.reduce((total, day) => total + day.meteredVolume, 0n)).toBe(network.meteredVolume);
  expect(days.reduce((total, day) => total + day.newMeters, 0)).toBe(network.meterCount);
}

const ENTITIES = [
  "Network",
  "Mandate",
  "Charge",
  "BalanceFallback",
  "ChargeFailure",
  "ChargeRevert",
  "ChargerReport",
  "MandateEvent",
  "NonceInvalidation",
  "Payer",
  "PayerAsset",
  "Merchant",
  "MerchantAsset",
  "MerchantCustomer",
  "DailyStat",
  "MerchantDailyStat",
  "Meter",
  "MeterSettlement",
  "MeterSettleFailure",
] as const;

/**
 * The test indexer refuses a second `process` that starts past a contract's own `start_block`,
 * which the meter has. So a meter case that goes on after a first range copies every row into a
 * fresh test indexer and processes the rest there, from the meter's start block. The copied rows
 * are read back from the store as a later batch reads them, which is where a handler that changes
 * a row in place counts twice.
 */
async function run(simulate: unknown[], after?: TestIndexer): Promise<TestIndexer> {
  const indexer = createTestIndexer();
  if (after !== undefined) {
    for (const name of ENTITIES) {
      const table = (of: TestIndexer) => of[name] as unknown as { getAll(): Promise<object[]>; set(row: object): void };
      for (const row of await table(after).getAll()) table(indexer).set(row);
    }
  }
  const range = after === undefined ? {} : { startBlock: METER_START };
  await indexer.process({ chains: { [CHAIN]: { ...range, simulate: simulate as never } } });
  return indexer;
}

describe("MandateMeter handlers", () => {
  const meterId = (n: number) => `${CHAIN}-${n}`;
  const B = METER_START + 10;

  const settlementIn = async (indexer: TestIndexer, block: number) =>
    (await indexer.MeterSettlement.getAll()).find((s) => s.transactionHash === tx(block));

  it("opens a meter, settles usage within its caps, and rolls the period as the contract does", async () => {
    const first = await run([
      meterCreated(B, 1, { periodCap: 3_000_000n, period: 3_600, maxTotal: 10_000_000n, expiresIn: 100_000 }),
      settled(B + 10, 1, 1_000_000n, 1_000_000n, 1_000_000n),
      // The receipt asks for 3,000,000 more; the period cap lets 2,000,000 through.
      settled(B + 20, 1, 2_000_000n, 3_000_000n, 4_000_000n),
    ]);
    expect(await first.Meter.getOrThrow(meterId(1))).toMatchObject({ periodStart: BigInt(at(B)), periodCharged: 3_000_000n, totalCharged: 3_000_000n });
    // A new period: the rest of the receipt settles.
    const indexer = await run([settled(B + 3_700, 1, 1_000_000n, 4_000_000n, 4_000_000n)], first);

    const meter = await indexer.Meter.getOrThrow(meterId(1));
    expect(meter).toMatchObject({
      contract: METER,
      payer_id: account(PAYER),
      merchant_id: account(MERCHANT),
      assetSymbol: "tAUSD",
      status: "Active",
      standing: "Active",
      ended: false,
      totalCharged: 4_000_000n,
      remaining: 6_000_000n,
      periodStart: BigInt(at(B) + 3_600),
      periodCharged: 1_000_000n,
      receiptTotal: 4_000_000n,
      settlementCount: 3,
      lastSettledAt: BigInt(at(B + 3_700)),
      closedAt: 0n,
      createdBlock: B,
      createdTx: tx(B),
    });
    expect(await settlementIn(indexer, B + 20)).toMatchObject({ amount: 2_000_000n, totalCharged: 3_000_000n, receiptTotal: 4_000_000n, sender: RELAYER });

    // Every figure exactly once: a handler that changed a stored row in place would double them.
    expect(await indexer.Merchant.getOrThrow(account(MERCHANT))).toMatchObject({
      meterCount: 1,
      activeMeters: 1,
      meteredRevenue: 4_000_000n,
      meterSettlements: 3,
      revenue: 0n,
      chargeCount: 0,
      mandateCount: 0,
    });
    expect(await indexer.MerchantAsset.getOrThrow(`${CHAIN}-${MERCHANT}-${TAUSD}`)).toMatchObject({ meteredRevenue: 4_000_000n, meterSettlements: 3, revenue: 0n });
    expect(await indexer.Payer.getOrThrow(account(PAYER))).toMatchObject({ meterCount: 1, meteredPaid: 4_000_000n, totalPaid: 0n });
    // Meter money is not mandate money, and a party seen only through a meter is not a mandate party.
    expect(await indexer.Network.getOrThrow(`${CHAIN}`)).toMatchObject({
      meter: METER,
      meterCount: 1,
      meteredVolume: 4_000_000n,
      volume: 0n,
      merchantCount: 0,
      payerCount: 0,
      meterMerchantCount: 1,
      meterPayerCount: 1,
    });
    const days = await indexer.DailyStat.getAll();
    expect(days.reduce((total, day) => total + day.volume, 0n)).toBe(0n);
    expect(days.reduce((total, day) => total + day.meterSettlements, 0)).toBe(3);
    await expectBalancedMeters(indexer);
  });

  it("makes a meter past due when a settlement cannot be funded, and the next funded one clears it", async () => {
    const terms = { periodCap: 1_000_000n, period: 60, maxTotal: 10_000_000n, expiresIn: 100_000 };
    const first = await run([
      meterCreated(B, 1, terms),
      meterCreated(B + 1, 2, { ...terms, payer: OTHER_PAYER }),
      // Meter 1 fails a full minute after it opened, which rolls its period.
      settleFailed(B + 70, 1, 2, 500_000n),
    ]);
    expect(await first.Meter.getOrThrow(meterId(1))).toMatchObject({ status: "Delinquent", standing: "PastDue", periodStart: BigInt(at(B) + 60) });
    expect(await first.Merchant.getOrThrow(account(MERCHANT))).toMatchObject({ activeMeters: 1, pastDueMeters: 1, liveMeters: 2 });
    await expectBalancedMeters(first);

    const indexer = await run(
      [
        // Meter 1 recovers; meter 2 fails and stays behind.
        settled(B + 75, 1, 500_000n, 500_000n, 500_000n),
        settleFailed(B + 80, 2, 1, 250_000n),
      ],
      first,
    );

    expect(await indexer.Meter.getOrThrow(meterId(1))).toMatchObject({
      status: "Active",
      standing: "Active",
      totalCharged: 500_000n,
      periodStart: BigInt(at(B) + 60),
      periodCharged: 500_000n,
      failureCount: 1,
      lastFailureReason: "InsufficientAllowance",
    });
    expect(await indexer.Meter.getOrThrow(meterId(2))).toMatchObject({
      status: "Delinquent",
      standing: "PastDue",
      failureCount: 1,
      lastFailureReason: "InsufficientBalance",
      lastFailureAmount: 250_000n,
      lastFailureAt: BigInt(at(B + 80)),
      // A failure rolls the period too: the contract keeps the roll when it reports the failure.
      periodStart: BigInt(at(B + 1) + 60),
    });
    const failures = await indexer.MeterSettleFailure.getAll();
    expect(failures.map((f) => [f.meter_id, f.reason, f.reasonCode, f.required])).toEqual([
      [meterId(1), "InsufficientAllowance", 2, 500_000n],
      [meterId(2), "InsufficientBalance", 1, 250_000n],
    ]);
    expect(await indexer.Merchant.getOrThrow(account(MERCHANT))).toMatchObject({ activeMeters: 1, pastDueMeters: 1, liveMeters: 2, meterFailures: 2 });
    expect(await indexer.Network.getOrThrow(`${CHAIN}`)).toMatchObject({ meterFailureCount: 2, meterSettlementCount: 1 });
    await expectBalancedMeters(indexer);
  });

  it("counts a party at its first mandate even when a meter saw it first, and keeps the two apart", async () => {
    const first = await run([
      meterCreated(B, 1, { periodCap: 1_000_000n, period: 60, maxTotal: 10_000_000n, expiresIn: 100_000 }),
      settled(B + 5, 1, 400_000n, 400_000n, 400_000n),
    ]);
    const indexer = await run(
      [
        created(B + 10, 1, { amount: 5_000_000n, period: 60, maxTotal: 10_000_000n, expiresIn: 1_000_000 }),
        charged(B + 11, 1, 5_000_000n, 5_000_000n, at(B + 10) + 60, { to: CHARGER }),
      ],
      first,
    );

    expect(await indexer.Network.getOrThrow(`${CHAIN}`)).toMatchObject({
      merchantCount: 1,
      payerCount: 1,
      meterMerchantCount: 1,
      meterPayerCount: 1,
      volume: 5_000_000n,
      meteredVolume: 400_000n,
    });
    expect(await indexer.Merchant.getOrThrow(account(MERCHANT))).toMatchObject({
      mandateCount: 1,
      customers: 1,
      revenue: 5_000_000n,
      meteredRevenue: 400_000n,
      firstSeenAt: BigInt(at(B)),
    });
    expect(await indexer.Payer.getOrThrow(account(PAYER))).toMatchObject({ totalPaid: 5_000_000n, meteredPaid: 400_000n });
    await expectBalancedBooks(indexer);
    await expectBalancedMeters(indexer);
  });

  it("cancels, and a receipt issued before then still settles without reopening it", async () => {
    const first = await run([
      meterCreated(B, 1, { periodCap: 5_000_000n, period: 3_600, maxTotal: 10_000_000n, expiresIn: 100_000 }),
      settled(B + 5, 1, 1_000_000n, 1_000_000n, 1_000_000n),
    ]);
    const indexer = await run(
      [
        {
          contract: "MandateMeter",
          event: "MeterCancelled",
          block: { number: B + 10, timestamp: at(B + 10) },
          transaction: { hash: tx(B + 10), from: MERCHANT, to: METER },
          params: { meterId: 1n, by: MERCHANT },
        },
        settled(B + 11, 1, 500_000n, 1_500_000n, 1_500_000n),
        settleFailed(B + 12, 1, 1, 100_000n),
      ],
      first,
    );

    expect(await indexer.Meter.getOrThrow(meterId(1))).toMatchObject({
      status: "Cancelled",
      standing: "Cancelled",
      ended: true,
      closedAt: BigInt(at(B + 10)),
      closedBlock: B + 10,
      closedTx: tx(B + 10),
      cancelledBy: MERCHANT,
      totalCharged: 1_500_000n,
      settlementCount: 2,
      failureCount: 1,
    });
    expect(await indexer.Network.getOrThrow(`${CHAIN}`)).toMatchObject({ cancelledMeters: 1, liveMeters: 0, openMeters: 0, meteredVolume: 1_500_000n });
    await expectBalancedMeters(indexer);
  });

  it("completes a meter whose lifetime cap is spent", async () => {
    const indexer = await run([
      meterCreated(B, 1, { periodCap: 1_000_000n, period: 60, maxTotal: 1_000_000n, expiresIn: 100_000 }),
      settled(B + 5, 1, 1_000_000n, 1_000_000n, 1_200_000n),
    ]);
    expect(await indexer.Meter.getOrThrow(meterId(1))).toMatchObject({ standing: "Completed", ended: false, remaining: 0n });
    expect(await indexer.Network.getOrThrow(`${CHAIN}`)).toMatchObject({ completedMeters: 1, liveMeters: 0, openMeters: 1 });
    await expectBalancedMeters(indexer);
  });

  it("expires a meter with no event to say so, and records the meter's nonces apart from the hub's", async () => {
    // Meter 2 expires 1,000 seconds after it opens. The sweep's historical passes run every 10,800
    // blocks from the chain's start block; the nonce event after the next one closes the range.
    const late = START + 10_800 * (Math.floor((B + 1_000 - START) / 10_800) + 1) + 1;
    const indexer = await run([
      meterCreated(B, 1, { periodCap: 1_000_000n, period: 60, maxTotal: 10_000_000n, expiresIn: 1_000_000 }),
      meterCreated(B + 1, 2, { payer: OTHER_PAYER, periodCap: 1_000_000n, period: 60, maxTotal: 10_000_000n, expiresIn: 1_000 }),
      {
        contract: "MandateMeter",
        event: "NonceInvalidated",
        block: { number: late, timestamp: at(late) },
        transaction: { hash: tx(late), from: OTHER_PAYER, to: METER },
        params: { signer: OTHER_PAYER, nonce: 9n },
      },
    ]);

    expect(await indexer.Meter.getOrThrow(meterId(2))).toMatchObject({ standing: "Expired", ended: true, status: "Active" });
    expect(await indexer.Meter.getOrThrow(meterId(1))).toMatchObject({ standing: "Active", ended: false });
    expect(await indexer.Network.getOrThrow(`${CHAIN}`)).toMatchObject({ meterCount: 2, activeMeters: 1, expiredMeters: 1, openMeters: 1, meterPayerCount: 2 });
    expect(await indexer.NonceInvalidation.getAll()).toEqual([expect.objectContaining({ contract: METER, signer: OTHER_PAYER, nonce: 9n })]);
    await expectBalancedMeters(indexer);
  });
});
