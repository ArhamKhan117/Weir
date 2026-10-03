import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { standingOf } from "@weir/shared";
import {
  GAS_BASE,
  GAS_CEILING,
  GAS_PER_MANDATE,
  MAX_BATCH_LIMIT,
  MAX_PAGES_PER_TICK,
  TickFailure,
  gasLimitFor,
  judge,
  planPages,
  runTick,
  selectDue,
  type DuePolicy,
  type Head,
  type MandateState,
  type TickConfig,
  type TickPorts,
  type WriteOutcome,
} from "./tick.js";

const NOW = 1_800_000_000n;
const PAYER = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

const policy: DuePolicy = { streamMinCharge: 10_000n, streamMaxAgeSeconds: 3_600n, intervalSeconds: 300n };

/** A periodic mandate that is due now. */
const periodic = (overrides: Partial<MandateState> = {}): MandateState => ({
  id: 1n,
  payer: PAYER,
  status: "Active",
  period: 60,
  nextChargeAt: NOW - 1n,
  expiresAt: NOW + 86_400n,
  amount: 5_000_000n,
  maxPerCharge: 5_000_000n,
  maxTotal: 30_000_000n,
  totalCharged: 0n,
  pausedAt: 0n,
  chargeable: true,
  quote: 5_000_000n,
  ...overrides,
});

/** A stream at 1 base unit a second, 100 seconds past its checkpoint: chargeable, not yet worth it. */
const stream = (overrides: Partial<MandateState> = {}): MandateState => ({
  id: 2n,
  payer: PAYER,
  status: "Active",
  period: 0,
  nextChargeAt: NOW - 100n,
  expiresAt: NOW + 86_400n,
  amount: 1n,
  maxPerCharge: 1_000_000n,
  maxTotal: 10_000_000n,
  totalCharged: 0n,
  pausedAt: 0n,
  chargeable: true,
  quote: 100n,
  ...overrides,
});

describe("judge", () => {
  it("charges a chargeable periodic mandate", () => {
    expect(judge(periodic(), NOW, policy)).toEqual({ action: "charge", reason: "periodic" });
  });

  it("waits for a periodic mandate the hub does not call chargeable", () => {
    expect(judge(periodic({ chargeable: false, quote: 0n, nextChargeAt: NOW + 10n }), NOW, policy)).toEqual({
      action: "wait",
      reason: "not-due",
    });
  });

  it("charges a past-due mandate: funding is not the hub's question, and a retry is how it recovers", () => {
    expect(judge(periodic({ status: "Delinquent" }), NOW, policy)).toEqual({ action: "charge", reason: "periodic" });
  });

  it("finishes the states nothing leaves", () => {
    expect(judge(periodic({ payer: ZERO }), NOW, policy)).toEqual({ action: "finished", reason: "unknown" });
    expect(judge(periodic({ status: "Cancelled" }), NOW, policy)).toEqual({ action: "finished", reason: "cancelled" });
    expect(judge(periodic({ expiresAt: NOW - 1n }), NOW, policy)).toEqual({ action: "finished", reason: "expired" });
    expect(judge(periodic({ totalCharged: 26_000_000n }), NOW, policy)).toEqual({ action: "finished", reason: "completed" });
    expect(judge(stream({ totalCharged: 10_000_000n }), NOW, policy)).toEqual({ action: "finished", reason: "completed" });
  });

  it("is still live at the expiry second itself, which the hub counts as inclusive", () => {
    expect(judge(periodic({ expiresAt: NOW }), NOW, policy)).toEqual({ action: "charge", reason: "periodic" });
  });

  it("waits on a paused stream", () => {
    expect(judge(stream({ pausedAt: NOW - 50n, chargeable: false, quote: 0n }), NOW, policy)).toEqual({
      action: "wait",
      reason: "paused",
    });
  });

  it("lets a stream accrue until one of its thresholds is met", () => {
    expect(judge(stream(), NOW, policy)).toEqual({ action: "wait", reason: "accruing" });
  });

  it("charges a stream whose quote reaches the minimum", () => {
    expect(judge(stream({ quote: 10_000n }), NOW, policy)).toEqual({ action: "charge", reason: "min-charge" });
    expect(judge(stream({ quote: 9_999n }), NOW, policy)).toEqual({ action: "wait", reason: "accruing" });
  });

  it("charges a stream that has reached its per-charge cap, since accrual above it is forfeited", () => {
    const capped = stream({ maxPerCharge: 500n, quote: 500n });
    expect(judge(capped, NOW, { ...policy, streamMinCharge: 1_000_000n })).toEqual({ action: "charge", reason: "capped" });
  });

  it("charges a stream whose quote is all the lifetime cap has left", () => {
    const last = stream({ maxTotal: 1_000n, totalCharged: 800n, quote: 200n });
    expect(judge(last, NOW, { ...policy, streamMinCharge: 1_000_000n })).toEqual({ action: "charge", reason: "capped" });
  });

  it("charges a stream once it is old enough, whatever it has accrued", () => {
    expect(judge(stream({ nextChargeAt: NOW - 3_600n }), NOW, policy)).toEqual({ action: "charge", reason: "max-age" });
    expect(judge(stream({ nextChargeAt: NOW - 3_599n }), NOW, policy)).toEqual({ action: "wait", reason: "accruing" });
  });

  it("charges a stream within two schedule intervals of expiry, since nothing is charged after it", () => {
    expect(judge(stream({ expiresAt: NOW + 600n }), NOW, policy)).toEqual({ action: "charge", reason: "near-expiry" });
    expect(judge(stream({ expiresAt: NOW + 601n }), NOW, policy)).toEqual({ action: "wait", reason: "accruing" });
  });

  it("finishes exactly the mandates the shared standing calls cancelled, expired or completed", () => {
    const arbitraryMandate = fc.record({
      status: fc.constantFrom("Active" as const, "Delinquent" as const, "Cancelled" as const),
      period: fc.constantFrom(0, 60, 3_600),
      expiresAt: fc.bigInt({ min: NOW - 100n, max: NOW + 100n }),
      amount: fc.bigInt({ min: 1n, max: 1_000n }),
      maxTotal: fc.bigInt({ min: 1n, max: 5_000n }),
      totalCharged: fc.bigInt({ min: 0n, max: 5_000n }),
      pausedAt: fc.constantFrom(0n, NOW - 10n),
      chargeable: fc.boolean(),
      quote: fc.bigInt({ min: 0n, max: 5_000n }),
    });
    fc.assert(
      fc.property(arbitraryMandate, (fields) => {
        const m = stream({ ...fields, maxPerCharge: fields.maxTotal });
        const verdict = judge(m, NOW, policy);
        const standing = standingOf(m, NOW);
        const finished = standing === "Cancelled" || standing === "Expired" || standing === "Completed";
        expect(verdict.action === "finished").toBe(finished);
        if (standing === "Paused") expect(verdict).toEqual({ action: "wait", reason: "paused" });
      }),
    );
  });
});

describe("selectDue", () => {
  it("orders healthy mandates before past-due ones, each oldest first, and caps the batch", () => {
    const mandates = [
      periodic({ id: 7n, status: "Delinquent" }),
      periodic({ id: 5n }),
      periodic({ id: 3n, status: "Delinquent" }),
      periodic({ id: 9n }),
      stream({ id: 4n }),
      periodic({ id: 1n, status: "Cancelled" }),
    ];
    const selection = selectDue(mandates, NOW, policy, 3);
    expect(selection.batch.map((entry) => entry.id)).toEqual([5n, 9n, 3n]);
    expect(selection.batch.map((entry) => entry.pastDue)).toEqual([false, false, true]);
    expect(selection.deferred.map((entry) => entry.id)).toEqual([7n]);
    expect(selection.waiting).toEqual({ "not-due": 0, paused: 0, accruing: 1 });
    expect(selection.finished).toEqual({ unknown: 0, cancelled: 1, expired: 0, completed: 0 });
  });

  it("selects nothing from nothing", () => {
    expect(selectDue([], NOW, policy, 50).batch).toEqual([]);
  });
});

describe("planPages", () => {
  const ids = (pages: readonly (readonly bigint[])[]) => pages.map((page) => page.map(Number));

  it("reads nothing from a hub with no mandates", () => {
    expect(planPages(1n, 200, 14, 0n)).toEqual({ pages: [], totalPages: 0 });
    expect(planPages(0n, 200, 14, 0n)).toEqual({ pages: [], totalPages: 0 });
  });

  it("reads every id from 1, in pages, the last one partial", () => {
    const plan = planPages(8n, 3, 14, 0n);
    expect(ids(plan.pages)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(plan.totalPages).toBe(3);
    expect(ids(planPages(7n, 3, 14, 0n).pages)).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  it("reads a rotating slice once the hub has more pages than a tick may read, wrapping at the end", () => {
    // 10 ids in pages of 2 is 5 pages; 2 a tick.
    expect(ids(planPages(11n, 2, 2, 0n).pages)).toEqual([[1, 2], [3, 4]]);
    expect(ids(planPages(11n, 2, 2, 1n).pages)).toEqual([[5, 6], [7, 8]]);
    expect(ids(planPages(11n, 2, 2, 2n).pages)).toEqual([[9, 10], [1, 2]]);
    expect(planPages(11n, 2, 2, 2n).totalPages).toBe(5);
  });

  it("visits every id within ceil(total / max) consecutive ticks, from any starting tick", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 6 }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        (count, pageSize, maxPages, first) => {
          const total = Math.ceil(count / pageSize);
          const ticks = Math.ceil(total / maxPages);
          const seen = new Set<bigint>();
          for (let tick = 0; tick < ticks; tick += 1) {
            const plan = planPages(BigInt(count + 1), pageSize, maxPages, first + BigInt(tick));
            expect(plan.pages.length).toBe(Math.min(total, maxPages));
            for (const page of plan.pages) for (const id of page) seen.add(id);
          }
          // Consecutive slices are contiguous, so `ticks` of them span at least every page once.
          expect(seen.size).toBe(count);
        },
      ),
    );
  });

  it("refuses a page size or page count that is not a positive integer", () => {
    expect(() => planPages(10n, 0, 14, 0n)).toThrow(RangeError);
    expect(() => planPages(10n, 200, 0, 0n)).toThrow(RangeError);
  });
});

describe("gasLimitFor", () => {
  it("is a base plus an allowance per mandate", () => {
    expect(gasLimitFor(1)).toBe(GAS_BASE + GAS_PER_MANDATE);
    expect(gasLimitFor(50)).toBe(7_700_000n);
  });

  it("never passes CRE's per-transaction ceiling, and the largest batch allowed fits under it", () => {
    expect(gasLimitFor(10_000)).toBe(GAS_CEILING);
    // A Mainnet vault's withdrawal needs far more than the default allowance.
    expect(gasLimitFor(2, 500_000n)).toBe(GAS_BASE + 1_000_000n);
    expect(GAS_BASE + GAS_PER_MANDATE * BigInt(MAX_BATCH_LIMIT)).toBeLessThanOrEqual(GAS_CEILING);
    expect(GAS_BASE + GAS_PER_MANDATE * BigInt(MAX_BATCH_LIMIT + 1)).toBeGreaterThan(GAS_CEILING);
  });

  it("refuses an empty batch", () => {
    expect(() => gasLimitFor(0)).toThrow(RangeError);
  });
});

describe("runTick", () => {
  const config: TickConfig = {
    hub: "0x1111111111111111111111111111111111111111",
    charger: "0x5555555555555555555555555555555555555555",
    pageSize: 2,
    maxBatch: 2,
    gasPerMandate: GAS_PER_MANDATE,
    policy,
  };
  const head: Head = { blockNumber: 1_234n, timestamp: NOW, nextMandateId: 6n };

  const fakes = (mandates: MandateState[], outcome: WriteOutcome = { txStatus: "success", receiverStatus: "success", txHash: "0xabc" }) => {
    const pageReads: Array<{ ids: bigint[]; blockNumber: bigint }> = [];
    const writes: Array<{ ids: bigint[]; gasLimit: bigint }> = [];
    const lines: string[] = [];
    const ports: TickPorts = {
      readHead: () => head,
      readPage: (ids, blockNumber) => {
        pageReads.push({ ids: [...ids], blockNumber });
        return ids.map((id) => mandates.find((m) => m.id === id) ?? periodic({ id, payer: ZERO }));
      },
      writeReport: (ids, gasLimit) => {
        writes.push({ ids: [...ids], gasLimit });
        return outcome;
      },
    };
    return { ports, pageReads, writes, runtime: { log: (line: string) => lines.push(line) }, lines };
  };

  it("reads every page at the head's block and writes nothing when nothing is due", () => {
    const { ports, pageReads, writes, runtime, lines } = fakes([stream({ id: 2n })]);
    const summary = runTick(runtime, config, ports);
    expect(pageReads).toEqual([
      { ids: [1n, 2n], blockNumber: 1_234n },
      { ids: [3n, 4n], blockNumber: 1_234n },
      { ids: [5n], blockNumber: 1_234n },
    ]);
    expect(writes).toEqual([]);
    expect(summary).toEqual({ blockNumber: "1234", timestamp: String(NOW), mandates: 5, read: 5, due: 0, deferred: 0, reported: [] });
    expect(lines.at(-1)).toBe("weir charger: nothing due; no report written");
  });

  it("writes one report for the batch, sized for its gas, and defers the rest", () => {
    const { ports, writes, runtime, lines } = fakes([periodic({ id: 4n }), periodic({ id: 1n }), periodic({ id: 5n })]);
    const summary = runTick(runtime, config, ports);
    expect(writes).toEqual([{ ids: [1n, 4n], gasLimit: gasLimitFor(2) }]);
    expect(summary).toMatchObject({ due: 3, deferred: 1, reported: ["1", "4"], gasLimit: String(gasLimitFor(2)), txHash: "0xabc" });
    expect(() => JSON.stringify(summary)).not.toThrow();
    expect(lines).toContain("weir charger: mandate 1 due (periodic), quote 5000000");
    expect(lines.some((line) => line.includes("report transaction 0xabc: success, onReport success"))).toBe(true);
  });

  it("fails the tick when the report transaction did not land", () => {
    const { ports, runtime } = fakes([periodic({ id: 1n })], { txStatus: "reverted", txHash: "0xdef", error: "out of gas" });
    expect(() => runTick(runtime, config, ports)).toThrow(TickFailure);
    expect(() => runTick(runtime, config, ports)).toThrow("transaction reverted: out of gas");
  });

  it("fails the tick when the forwarder landed the report but onReport reverted", () => {
    const { ports, runtime } = fakes([periodic({ id: 1n })], { txStatus: "success", receiverStatus: "reverted" });
    expect(() => runTick(runtime, config, ports)).toThrow("onReport reverted");
  });

  it("never reads more pages than CRE allows one execution", () => {
    const { ports, pageReads, runtime, lines } = fakes([]);
    runTick(runtime, { ...config, pageSize: 1 }, { ...ports, readHead: () => ({ ...head, nextMandateId: 101n }) });
    expect(pageReads).toHaveLength(MAX_PAGES_PER_TICK);
    expect(lines).toContain(`weir charger: reading ${MAX_PAGES_PER_TICK} of 100 pages this tick; later ticks read the rest`);
  });
});
