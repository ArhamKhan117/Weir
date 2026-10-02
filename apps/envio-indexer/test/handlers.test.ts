/**
 * The handlers end to end on simulated events: the real `config.yaml`, schema and handlers, run
 * by Envio's test indexer with no network. The expiry sweep's one RPC read is answered by a stub
 * that dates block `n` to `T0 + (n - START)`.
 */

import { createTestIndexer, type Address, type Mandate, type TestIndexer } from "envio";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isLive, type Standing } from "../src/model.js";
import { NETWORKS, REVERT_REASONS } from "../src/networks.js";

const CHAIN = 10143;
const NETWORK = NETWORKS[CHAIN]!;
const START = NETWORK.startBlock;
const T0 = 1_790_000_000;
const at = (block: number) => T0 + (block - START);

const HUB = NETWORK.hub as Address;
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

describe("MandateHub and MandateCharger handlers", () => {
  const indexer = createTestIndexer();

  beforeAll(() => {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params: [string, boolean] };
      if (request.method !== "eth_getBlockByNumber") throw new Error(`unexpected ${request.method}`);
      const block = Number(BigInt(request.params[0]));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { timestamp: `0x${at(block).toString(16)}` } }));
    });
  });
  afterAll(() => vi.unstubAllGlobals());

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
