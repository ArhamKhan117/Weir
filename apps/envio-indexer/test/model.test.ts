import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  NO_MANDATES,
  commitmentOf,
  dayOf,
  failureReason,
  moveCount,
  mrrOf,
  resumedCheckpoint,
  standingOf,
  triggerOf,
  type MandateFigures,
  type NetworkInfo,
  type Standing,
  type Status,
} from "../src/model.js";

// The originals this model restates. They exist in the monorepo, not in a checkout of this
// directory alone, where the comparisons below are skipped.
const sharedTypes = fileURLToPath(new URL("../../../packages/shared/src/types.ts", import.meta.url));
const apiStats = fileURLToPath(new URL("../../api/src/domain/stats.ts", import.meta.url));

type ApiStanding = "Active" | "Paused" | "Past due" | "Cancelled" | "Expired" | "Completed";
interface Originals {
  standingOf: (mandate: MandateFigures, now: bigint) => ApiStanding;
  monthlyAmount: (mandate: { standing: ApiStanding; period: number; amount: string }) => bigint;
}
const originals: Originals | undefined =
  existsSync(sharedTypes) && existsSync(apiStats)
    ? {
        standingOf: ((await import(sharedTypes)) as Pick<Originals, "standingOf">).standingOf,
        monthlyAmount: ((await import(apiStats)) as Pick<Originals, "monthlyAmount">).monthlyAmount,
      }
    : undefined;

const toApi = (standing: Standing): ApiStanding => (standing === "PastDue" ? "Past due" : standing);

/** Every combination that can decide a standing, around each boundary. */
function* grid(): Generator<{ mandate: MandateFigures; now: bigint }> {
  const statuses: Status[] = ["Active", "Delinquent", "Cancelled"];
  const expiresAt = 1_000n;
  for (const status of statuses)
    for (const period of [0, 60, 2_592_000])
      for (const amount of [1n, 5n])
        for (const maxTotal of [5n, 10n])
          for (const totalCharged of [0n, 4n, 5n, 6n, 9n, 10n])
            for (const pausedAt of [0n, 500n])
              for (const now of [999n, 1_000n, 1_001n])
                yield { mandate: { status, pausedAt, expiresAt, totalCharged, maxTotal, amount, period }, now };
}

describe("standing", () => {
  it.skipIf(originals === undefined)("agrees with the shared standingOf everywhere it can differ", () => {
    let cases = 0;
    for (const { mandate, now } of grid()) {
      expect(toApi(standingOf(mandate, now)), JSON.stringify({ ...mandate, now }, (_, v) => (typeof v === "bigint" ? `${v}` : v))).toBe(
        originals?.standingOf(mandate, now),
      );
      cases += 1;
    }
    expect(cases).toBeGreaterThan(1_000);
  });

  it("puts cancellation before expiry, expiry before completion, and pause before delinquency", () => {
    const base: MandateFigures = { status: "Delinquent", pausedAt: 5n, expiresAt: 100n, totalCharged: 0n, maxTotal: 10n, amount: 1n, period: 0 };
    expect(standingOf(base, 50n)).toBe("Paused");
    expect(standingOf({ ...base, pausedAt: 0n }, 50n)).toBe("PastDue");
    expect(standingOf({ ...base, totalCharged: 10n }, 50n)).toBe("Completed");
    expect(standingOf({ ...base, totalCharged: 10n }, 101n)).toBe("Expired");
    expect(standingOf({ ...base, status: "Cancelled" }, 101n)).toBe("Cancelled");
  });
});

describe("monthly figures", () => {
  it.skipIf(originals === undefined)("MRR is the API's monthlyAmount", () => {
    const standings: Standing[] = ["Active", "Paused", "PastDue", "Cancelled", "Expired", "Completed"];
    for (const standing of standings)
      for (const period of [0, 60, 604_800, 2_592_000, 31_536_000])
        for (const amount of [1n, 9_990_000n, 123_456_789n]) {
          expect(mrrOf({ amount, period }, standing)).toBe(
            originals?.monthlyAmount({ standing: toApi(standing), period, amount: amount.toString() }),
          );
        }
  });

  it("commits a payer to periodic mandates that are running or behind, rounded down", () => {
    expect(commitmentOf({ amount: 9_990_000n, period: 2_592_000 }, "Active")).toBe(9_990_000n);
    expect(commitmentOf({ amount: 1n, period: 604_800 }, "PastDue")).toBe(4n);
    expect(commitmentOf({ amount: 9_990_000n, period: 2_592_000 }, "Completed")).toBe(0n);
    expect(commitmentOf({ amount: 1_000n, period: 0 }, "Active")).toBe(0n);
  });
});

describe("resume", () => {
  it("moves the checkpoint by the billable part of the pause, as MandateHub._resume does", () => {
    // Paused after the checkpoint: the pause is billable from the moment it began.
    expect(resumedCheckpoint(100n, 150n, 400n)).toBe(350n);
    // Paused before the stream started: only the time past the start moves it.
    expect(resumedCheckpoint(1_000n, 10n, 500n)).toBe(1_000n);
    expect(resumedCheckpoint(1_000n, 10n, 1_500n)).toBe(1_500n);
  });
});

describe("helpers", () => {
  it("names every failure code, and refuses to guess at others", () => {
    expect([1, 2, 3, 4, 0].map(failureReason)).toEqual([
      "InsufficientBalance",
      "InsufficientAllowance",
      "TransferRefused",
      "Unknown",
      "Unknown",
    ]);
  });

  it("tells a report, a batch and a direct call apart by where the transaction went", () => {
    const network: NetworkInfo = {
      name: "Test",
      startBlock: 0,
      hub: "0x0000000000000000000000000000000000000001",
      charger: "0x0000000000000000000000000000000000000002",
      forwarder: "0x0000000000000000000000000000000000000003",
      simulationForwarder: "0x0000000000000000000000000000000000000004",
      assets: {},
      rpcUrl: "",
    };
    expect(triggerOf("0x0000000000000000000000000000000000000003", network)).toBe("Cre");
    expect(triggerOf("0x0000000000000000000000000000000000000004", network)).toBe("Cre");
    expect(triggerOf("0x0000000000000000000000000000000000000002", network)).toBe("Keeper");
    expect(triggerOf("0x0000000000000000000000000000000000000001", network)).toBe("Direct");
    expect(triggerOf(undefined, network)).toBe("Direct");
  });

  it("dates a moment to its UTC day", () => {
    expect(dayOf(1_790_349_912n)).toEqual({ date: "2026-09-25", dayStart: 1_790_294_400n });
    expect(dayOf(1_790_294_400n).date).toBe("2026-09-25");
    expect(dayOf(1_790_294_399n).date).toBe("2026-09-24");
  });

  it("moves one mandate between counts, keeping the live total", () => {
    const one = moveCount(NO_MANDATES, undefined, "Active");
    expect(one).toMatchObject({ activeMandates: 1, liveMandates: 1 });
    const paused = moveCount(one, "Active", "Paused");
    expect(paused).toMatchObject({ activeMandates: 0, pausedMandates: 1, liveMandates: 1 });
    expect(moveCount(paused, "Paused", "Cancelled")).toMatchObject({ pausedMandates: 0, cancelledMandates: 1, liveMandates: 0 });
  });
});
