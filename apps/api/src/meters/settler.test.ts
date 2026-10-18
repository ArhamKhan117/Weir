import type { Hex } from "viem";
import { describe, expect, it } from "vitest";

import type { MeterStore } from "../db/meters.js";
import { silentLogger } from "../log.js";
import { RejectedOnChainError } from "../relay/relayer.js";
import { MeterSettler } from "./settler.js";

const SIG = `0x${"11".repeat(65)}` as Hex;

/** A store with fixed rows to settle, recording what was marked. */
function fakeStore(rows: { meter_id: string; total: string; issued_at: string; total_charged: string }[]) {
  const marked: [bigint, bigint, number][] = [];
  const queries: unknown[] = [];
  const store = {
    toSettle: async (input: unknown) => {
      queries.push(input);
      return rows.map((row) => ({ ...row, signature: SIG }));
    },
    markSettling: async (id: bigint, total: bigint, now: number) => {
      marked.push([id, total, now]);
    },
  } as unknown as MeterStore;
  return { store, marked, queries };
}

describe("the settler", () => {
  it("settles each due meter with its latest receipt and marks it in flight", async () => {
    const { store, marked, queries } = fakeStore([
      { meter_id: "1", total: "5000", issued_at: "100", total_charged: "0" },
      { meter_id: "2", total: "900", issued_at: "101", total_charged: "300" },
    ]);
    const sent: { meterId: bigint; total: bigint; issuedAt: bigint }[] = [];
    const settler = new MeterSettler({
      store,
      settle: async (receipt, signature) => {
        expect(signature).toBe(SIG);
        sent.push(receipt);
        return { transaction: `0x${"ab".repeat(32)}` as Hex };
      },
      logger: silentLogger,
      minAmount: 100n,
      maxAgeSeconds: 600,
      now: () => 1_000,
    });
    expect(await settler.tick()).toBe(2);
    expect(sent).toEqual([
      { meterId: 1n, total: 5_000n, issuedAt: 100n },
      { meterId: 2n, total: 900n, issuedAt: 101n },
    ]);
    expect(marked).toEqual([
      [1n, 5_000n, 1_000],
      [2n, 900n, 1_000],
    ]);
    expect(queries[0]).toMatchObject({ minAmount: 100n, maxAgeSeconds: 600, retrySeconds: 120, nowSeconds: 1_000 });
  });

  it("backs off a receipt the meter refuses by name, and retries one that failed in transit", async () => {
    const { store, marked } = fakeStore([
      { meter_id: "1", total: "5000", issued_at: "100", total_charged: "5000" },
      { meter_id: "2", total: "700", issued_at: "100", total_charged: "0" },
    ]);
    const settler = new MeterSettler({
      store,
      settle: async (receipt) => {
        if (receipt.meterId === 1n) throw new RejectedOnChainError({ name: "NothingToSettle", detail: "nothing is owed" });
        throw new Error("the RPC timed out");
      },
      logger: silentLogger,
      minAmount: 1n,
      maxAgeSeconds: 60,
      now: () => 2_000,
    });
    expect(await settler.tick()).toBe(0);
    // The refused one waits out the retry window; the one lost in transit goes again next tick.
    expect(marked).toEqual([[1n, 5_000n, 2_000]]);
  });
});
