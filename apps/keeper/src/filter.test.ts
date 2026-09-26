import { zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import type { MandateRecord } from "@weir/shared";
import { judge, readMandates, selectDue, type DuePolicy, type MandateRead } from "./filter.js";

const NOW = 1_800_000_000n;
const PAYER: Address = "0x2222222222222222222222222222222222222222";
const MERCHANT: Address = "0x3333333333333333333333333333333333333333";
const ASSET: Address = "0x4444444444444444444444444444444444444444";

const policy: DuePolicy = { streamMinCharge: 10_000n, streamMaxAgeSeconds: 3_600n, intervalSeconds: 5n };

const periodicRecord: MandateRecord = {
  id: 1n,
  payer: PAYER,
  merchant: MERCHANT,
  asset: ASSET,
  vault: zeroAddress,
  manager: zeroAddress,
  amount: 5_000_000n,
  period: 60,
  nextChargeAt: NOW - 1n,
  maxPerCharge: 5_000_000n,
  maxTotal: 30_000_000n,
  totalCharged: 0n,
  expiresAt: NOW + 86_400n,
  pausedAt: 0n,
  status: "Active",
};

/** A stream of 100 base units a second whose checkpoint is `age` seconds ago. */
function stream(age: bigint, overrides: Partial<MandateRecord> = {}): MandateRecord {
  return {
    ...periodicRecord,
    id: 2n,
    amount: 100n,
    period: 0,
    nextChargeAt: NOW - age,
    maxPerCharge: 1_000_000n,
    maxTotal: 10_000_000n,
    ...overrides,
  };
}

/** What `isChargeable` and `quoteCharge` would answer for `mandate` at `NOW`, as the hub computes them. */
function read(mandate: MandateRecord): MandateRead {
  const live = mandate.payer !== zeroAddress && mandate.status !== "Cancelled" && mandate.pausedAt === 0n && NOW <= mandate.expiresAt;
  if (mandate.period === 0) {
    const chargeable = live && NOW > mandate.nextChargeAt && mandate.totalCharged < mandate.maxTotal;
    const accrued = mandate.amount * (NOW - mandate.nextChargeAt);
    const left = mandate.maxTotal - mandate.totalCharged;
    const cap = mandate.maxPerCharge < left ? mandate.maxPerCharge : left;
    return { id: mandate.id, mandate, chargeable, quote: chargeable ? (accrued < cap ? accrued : cap) : 0n };
  }
  const chargeable = live && NOW >= mandate.nextChargeAt && mandate.totalCharged + mandate.amount <= mandate.maxTotal;
  return { id: mandate.id, mandate, chargeable, quote: chargeable ? mandate.amount : 0n };
}

const verdict = (mandate: MandateRecord, now: bigint = NOW) => judge(read(mandate), now, policy);

describe("periodic mandates", () => {
  it("are charged as soon as they are chargeable", () => {
    expect(verdict(periodicRecord)).toEqual({ action: "charge", reason: "periodic" });
    expect(verdict({ ...periodicRecord, nextChargeAt: NOW })).toEqual({ action: "charge", reason: "periodic" });
  });

  it("wait before their boundary", () => {
    expect(verdict({ ...periodicRecord, nextChargeAt: NOW + 1n })).toEqual({ action: "wait", reason: "not-due" });
  });

  it("keep being charged while past due, so they recover when the payer tops up", () => {
    expect(verdict({ ...periodicRecord, status: "Delinquent" })).toEqual({ action: "charge", reason: "periodic" });
  });

  it("are dropped once the lifetime cap cannot take another period", () => {
    expect(verdict({ ...periodicRecord, totalCharged: 25_000_001n })).toEqual({ action: "drop", reason: "completed" });
    expect(verdict({ ...periodicRecord, totalCharged: 25_000_000n })).toEqual({ action: "charge", reason: "periodic" });
  });
});

describe("streams", () => {
  it("are charged once the quote reaches the minimum charge", () => {
    expect(verdict(stream(100n))).toEqual({ action: "charge", reason: "min-charge" });
    expect(verdict(stream(101n))).toEqual({ action: "charge", reason: "min-charge" });
  });

  it("wait while the quote is below the minimum and the checkpoint is young", () => {
    expect(read(stream(99n)).quote).toBe(9_900n);
    expect(verdict(stream(99n))).toEqual({ action: "wait", reason: "accruing" });
  });

  it("are charged at the maximum age whatever they have accrued", () => {
    const slow = { amount: 1n };
    expect(verdict(stream(3_600n, slow))).toEqual({ action: "charge", reason: "max-age" });
    expect(verdict(stream(3_599n, slow))).toEqual({ action: "wait", reason: "accruing" });
  });

  it("are charged within two intervals of expiry, so the tail is not lost", () => {
    const slow = { amount: 1n };
    expect(verdict(stream(30n, { ...slow, expiresAt: NOW + 10n }))).toEqual({ action: "charge", reason: "near-expiry" });
    expect(verdict(stream(30n, { ...slow, expiresAt: NOW }))).toEqual({ action: "charge", reason: "near-expiry" });
    expect(verdict(stream(30n, { ...slow, expiresAt: NOW + 11n }))).toEqual({ action: "wait", reason: "accruing" });
  });

  it("are charged once the quote reaches the per-charge cap, since accrual above it is forfeited", () => {
    const capped = stream(60n, { maxPerCharge: 5_000n });
    expect(read(capped).quote).toBe(5_000n);
    expect(verdict(capped)).toEqual({ action: "charge", reason: "capped" });
    expect(verdict(stream(49n, { maxPerCharge: 5_000n }))).toEqual({ action: "wait", reason: "accruing" });
  });

  it("are charged once the quote reaches what the lifetime cap has left", () => {
    const last = stream(60n, { maxTotal: 1_000_000n, totalCharged: 997_000n });
    expect(read(last).quote).toBe(3_000n);
    expect(verdict(last)).toEqual({ action: "charge", reason: "capped" });
  });

  it("wait while paused, and before they start", () => {
    expect(verdict(stream(600n, { pausedAt: NOW - 30n }))).toEqual({ action: "wait", reason: "paused" });
    expect(verdict(stream(-60n))).toEqual({ action: "wait", reason: "not-due" });
  });

  it("are dropped once the lifetime cap is spent", () => {
    expect(verdict(stream(600n, { totalCharged: 10_000_000n }))).toEqual({ action: "drop", reason: "completed" });
  });
});

describe("dropping", () => {
  it("removes an expired mandate, and keeps one at its inclusive expiry", () => {
    expect(verdict({ ...periodicRecord, expiresAt: NOW - 1n })).toEqual({ action: "drop", reason: "expired" });
    expect(verdict(stream(600n, { expiresAt: NOW - 1n }))).toEqual({ action: "drop", reason: "expired" });
    expect(verdict({ ...periodicRecord, expiresAt: NOW })).toEqual({ action: "charge", reason: "periodic" });
  });

  it("removes a cancelled mandate, whatever else is true of it", () => {
    expect(verdict({ ...periodicRecord, status: "Cancelled" })).toEqual({ action: "drop", reason: "cancelled" });
    expect(verdict(stream(600n, { status: "Cancelled", pausedAt: NOW }))).toEqual({ action: "drop", reason: "cancelled" });
  });

  it("removes an id the hub does not know", () => {
    expect(verdict({ ...periodicRecord, payer: zeroAddress })).toEqual({ action: "drop", reason: "unknown" });
  });
});

describe("selectDue", () => {
  it("splits a read into due, waiting and dropped, with the due ids ascending", () => {
    const mandates = [
      read({ ...stream(200n), id: 9n }),
      read({ ...periodicRecord, id: 4n }),
      read({ ...periodicRecord, id: 5n, nextChargeAt: NOW + 60n }),
      read({ ...periodicRecord, id: 6n, status: "Cancelled" }),
      read({ ...stream(600n), id: 7n, pausedAt: NOW - 1n }),
      read({ ...periodicRecord, id: 8n, expiresAt: NOW - 1n }),
    ];
    const selection = selectDue({ blockNumber: 1n, timestamp: NOW, mandates }, policy);
    expect(selection.due.map((entry) => [entry.read.id, entry.reason])).toEqual([
      [4n, "periodic"],
      [9n, "min-charge"],
    ]);
    expect(selection.waiting).toEqual([
      { id: 5n, reason: "not-due" },
      { id: 7n, reason: "paused" },
    ]);
    expect(selection.dropped).toEqual([
      { id: 6n, reason: "cancelled" },
      { id: 8n, reason: "expired" },
    ]);
  });
});

describe("readMandates", () => {
  const raw = { ...periodicRecord, status: 1 };

  it("reads the clock and every id in one call, and pins any further call to the first one's block", async () => {
    const calls: Array<{ functions: string[]; blockNumber: bigint | undefined }> = [];
    const client = {
      multicall: async (args: { contracts: Array<{ functionName: string }>; blockNumber?: bigint; batchSize?: number }) => {
        expect(args.batchSize).toBe(0);
        calls.push({ functions: args.contracts.map((call) => call.functionName), blockNumber: args.blockNumber });
        return args.contracts.map((call) =>
          call.functionName === "getBlockNumber" ? 77n
          : call.functionName === "getCurrentBlockTimestamp" ? NOW
          : call.functionName === "getMandate" ? raw
          : call.functionName === "isChargeable" ? true
          : 5_000_000n,
        );
      },
    };
    const read = await readMandates(client as never, { hub: PAYER, multicall: MERCHANT, ids: [1n, 2n, 3n], idsPerRead: 2 });

    expect(calls).toEqual([
      {
        functions: ["getBlockNumber", "getCurrentBlockTimestamp", "getMandate", "isChargeable", "quoteCharge", "getMandate", "isChargeable", "quoteCharge"],
        blockNumber: undefined,
      },
      { functions: ["getMandate", "isChargeable", "quoteCharge"], blockNumber: 77n },
    ]);
    expect(read.blockNumber).toBe(77n);
    expect(read.timestamp).toBe(NOW);
    expect(read.mandates.map((entry) => [entry.id, entry.mandate.status, entry.chargeable, entry.quote])).toEqual([
      [1n, "Delinquent", true, 5_000_000n],
      [2n, "Delinquent", true, 5_000_000n],
      [3n, "Delinquent", true, 5_000_000n],
    ]);
  });
});
