/**
 * One keeper pass against the real contracts on a local anvil node: periodic and streaming
 * mandates in every state the keeper distinguishes, charged through `MandateCharger`, with the
 * merchants' balances checked to the base unit.
 *
 * Runs whenever `anvil` is on PATH, building the contracts first if `out/` is empty, and skips
 * with the reason otherwise.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletClient, http, type Abi, type Address } from "viem";
import { anvil } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MULTICALL3_ADDRESS, mandateHubAbi } from "@weir/shared";
import { anvilAvailability, startWorld, type World } from "../test/anvilWorld.js";
import { chargeDue, createChargeTransport, gasLimitFor, RetrySchedule } from "./charge.js";
import { DEFAULT_GAS_POLICY } from "./config.js";
import { discover, MandateCursor } from "./discover.js";
import { createRpcReader, HistorySource } from "./history.js";
import { Keeper, type PassResult } from "./keeper.js";
import { createMemoryLogger, silentLogger } from "./log.js";

const availability = anvilAvailability();
const title = availability.available ? "keeper on anvil" : `keeper on anvil (skipped: ${availability.reason})`;

const DOLLAR = 1_000_000n;
const merchant = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

describe.skipIf(!availability.available)(title, { timeout: 60_000 }, () => {
  let world: World;
  let directory: string;
  let keeper: Keeper;
  let log: ReturnType<typeof createMemoryLogger>;
  let history: HistorySource;
  let transport: ReturnType<typeof createChargeTransport>;
  let pass: PassResult;
  const ids: Record<string, bigint> = {};
  const checkpoints: Record<string, bigint> = {};
  let before: bigint;
  let pausedSettlement: bigint;

  beforeAll(async () => {
    world = await startWorld();
    directory = await mkdtemp(join(tmpdir(), "weir-keeper-anvil-"));
    const { payer, brokePayer } = world;
    const create = async (name: string, from: typeof payer, terms: Parameters<World["createMandate"]>[1]) => {
      const created = await world.createMandate(from, terms);
      ids[name] = created.id;
      checkpoints[name] = created.at;
    };

    await create("periodic", payer, { merchant: merchant(1), amount: 5n * DOLLAR, period: 60, maxTotal: 30n * DOLLAR });
    await create("notDue", payer, { merchant: merchant(2), amount: 5n * DOLLAR, period: 60, startAt: (await world.latestTimestamp()) + 3_600n });
    await create("unfunded", brokePayer, { merchant: merchant(3), amount: 5n * DOLLAR, period: 60 });
    await create("fastStream", payer, { merchant: merchant(4), amount: 1_000n, period: 0, maxPerCharge: 10n * DOLLAR, maxTotal: 100n * DOLLAR });
    await create("oldStream", payer, { merchant: merchant(5), amount: 1n, period: 0, maxPerCharge: DOLLAR, maxTotal: 100n * DOLLAR });
    await create("cancelled", payer, { merchant: merchant(6), amount: DOLLAR, period: 60 });
    await world.write(payer, world.hub, mandateHubAbi as Abi, "cancelMandate", [ids.cancelled]);
    await create("expiring", payer, {
      merchant: merchant(7),
      amount: DOLLAR,
      period: 60,
      startAt: (await world.latestTimestamp()) + 5n,
      expiresAt: (await world.latestTimestamp()) + 30n,
    });
    await create("paused", payer, { merchant: merchant(8), amount: 1_000n, period: 0, maxPerCharge: DOLLAR, maxTotal: 100n * DOLLAR });
    await world.write(payer, world.hub, mandateHubAbi as Abi, "pauseMandate", [ids.paused]);
    await create("capped", payer, { merchant: merchant(9), amount: 100n, period: 0, maxPerCharge: 5_000n, maxTotal: 100n * DOLLAR });

    await world.warp(120n);

    await create("youngStream", payer, { merchant: merchant(10), amount: 1n, period: 0, maxPerCharge: DOLLAR, maxTotal: DOLLAR });
    const now = await world.latestTimestamp();
    await create("tail", payer, { merchant: merchant(11), amount: 10n, period: 0, maxPerCharge: DOLLAR, maxTotal: DOLLAR, expiresAt: now + 10n });
    // Two blocks so the youngest streams have accrued something the read can see.
    await world.mine(2);

    pausedSettlement = await world.balanceOf(merchant(8));
    before = await world.latestTimestamp();

    const cursor = await MandateCursor.open(join(directory, "cursor.json"), {
      chainId: world.chainId,
      hub: world.hub,
      startBlock: world.startBlock,
    });
    history = new HistorySource({ rpc: createRpcReader(world.publicClient, world.hub, 100), rpcChunkBlocks: 100, chainId: world.chainId, log: silentLogger });
    const walletClient = createWalletClient({ account: world.keeper, chain: anvil, transport: http(world.rpcUrl) });
    transport = createChargeTransport({ publicClient: world.publicClient, walletClient, charger: world.charger });
    log = createMemoryLogger();
    keeper = new Keeper({
      chainId: world.chainId,
      publicClient: world.publicClient,
      transport,
      keeper: world.keeper.address,
      hub: world.hub,
      charger: world.charger,
      multicall: MULTICALL3_ADDRESS,
      history,
      cursor,
      policy: { streamMinCharge: 10_000n, streamMaxAgeSeconds: 100n, intervalSeconds: 5n },
      batchSize: 3,
      gas: DEFAULT_GAS_POLICY,
      assets: { tAUSD: world.token },
      retries: new RetrySchedule(),
      log,
    });

    pass = await keeper.runPass();
  }, 60_000);

  afterAll(async () => {
    await world?.stop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it("charges what is due, in batches, and pays each merchant exactly", async () => {
    expect(pass.errors).toEqual([]);
    expect(pass.ok).toBe(true);
    expect(pass.due.map((entry) => [entry.id, entry.reason])).toEqual([
      [ids.periodic, "periodic"],
      [ids.unfunded, "periodic"],
      [ids.fastStream, "min-charge"],
      [ids.oldStream, "max-age"],
      [ids.capped, "capped"],
      [ids.tail, "near-expiry"],
    ]);

    // Batches of three, one block each, one second apart.
    expect(pass.batches.map((batch) => batch.ids)).toEqual([
      [ids.periodic, ids.unfunded, ids.fastStream],
      [ids.oldStream, ids.capped, ids.tail],
    ]);
    const [first, second] = await Promise.all(
      pass.batches.map((batch) => world.publicClient.getBlock({ blockNumber: batch.blockNumber })),
    );
    expect(first?.timestamp).toBe(before + 1n);
    expect(second?.timestamp).toBe(before + 2n);

    expect(await world.balanceOf(merchant(1))).toBe(5n * DOLLAR);
    expect(await world.balanceOf(merchant(3))).toBe(0n);
    expect(await world.balanceOf(merchant(4))).toBe(1_000n * (before + 1n - checkpoints.fastStream!));
    expect(await world.balanceOf(merchant(5))).toBe(before + 2n - checkpoints.oldStream!);
    expect(await world.balanceOf(merchant(9))).toBe(5_000n);
    expect(await world.balanceOf(merchant(11))).toBe(10n * (before + 2n - checkpoints.tail!));
    for (const untouched of [2, 6, 7, 10]) expect(await world.balanceOf(merchant(untouched))).toBe(0n);
    expect(await world.balanceOf(merchant(8))).toBe(pausedSettlement);

    const unfunded = await world.publicClient.readContract({ address: world.hub, abi: mandateHubAbi, functionName: "getMandate", args: [ids.unfunded!] });
    expect(unfunded.status).toBe(1); // Delinquent

    expect(pass.counts).toEqual({ workingSet: 9, due: 6, charged: 5, pastDue: 1, reverted: 0, dropped: 1, deferred: 0 });
    expect(log.lines).toContain(`info mandate ${ids.periodic} charged $5.00 tAUSD (periodic)`);
    expect(log.lines).toContain(`info mandate ${ids.capped} charged $0.005 tAUSD (capped)`);
    expect(log.lines).toContain(`info mandate ${ids.unfunded} past due: the payer's balance is too low for $5.00 tAUSD; next attempt in 1m`);
    expect(log.lines).toContain(`info mandate ${ids.expiring} dropped: expired`);
    // Created and cancelled inside one scan, so it never entered the working set.
    expect(pass.discovered?.added).not.toContain(ids.cancelled);
  });

  it("sends each batch with its estimate plus the margin, and nothing more", async () => {
    for (const batch of pass.batches) {
      expect(batch.status).toBe("success");
      expect(batch.gasLimit).toBe(gasLimitFor(batch.estimate, DEFAULT_GAS_POLICY));
      const transaction = await world.publicClient.getTransaction({ hash: batch.hash });
      expect(transaction.gas).toBe(batch.gasLimit);
      expect(batch.gasUsed).toBeLessThanOrEqual(batch.gasLimit);
      expect(batch.estimate - batch.gasUsed).toBeLessThan(batch.estimate / 20n);
    }
  });

  it("keeps every live mandate, removes the cancelled and the expired, and persists the set", async () => {
    const live = ["periodic", "notDue", "unfunded", "fastStream", "oldStream", "paused", "capped", "youngStream", "tail"];
    const expected = live.map((name) => ids[name]!).sort((a, b) => (a < b ? -1 : 1));
    expect(keeper.cursor.ids).toEqual(expected);

    await keeper.cursor.settle();
    const file = JSON.parse(await readFile(join(directory, "cursor.json"), "utf8")) as { mandateIds: string[] };
    expect(file.mandateIds).toEqual(expected.map(String));
  });

  it("serves what is due now, leaving out a mandate that is waiting to retry", async () => {
    await world.mine(1);
    const due = await keeper.dueNow();
    // The tail stream is due again one block later; the unfunded mandate is due but waits a minute.
    expect(due.ids).toEqual([ids.tail]);
  });

  it("rebuilds the working set when the cursor is deleted, and removes ids on terminal reverts", async () => {
    await rm(join(directory, "cursor.json"));
    const cursor = await MandateCursor.open(join(directory, "cursor.json"), {
      chainId: world.chainId,
      hub: world.hub,
      startBlock: world.startBlock,
    });
    expect(cursor.outcome).toEqual({ kind: "fresh" });
    await discover({ cursor, history, head: await world.publicClient.getBlockNumber(), log: silentLogger });
    expect(cursor.ids).not.toContain(ids.cancelled);
    expect(cursor.ids).toContain(ids.expiring);
    expect(cursor.size).toBe(10);

    const run = await chargeDue([ids.notDue!, ids.cancelled!, ids.expiring!, 999n], {
      transport,
      batchSize: 10,
      gas: DEFAULT_GAS_POLICY,
      contracts: { hub: world.hub, charger: world.charger },
    });
    expect(run.complete).toBe(true);
    expect(run.outcomes.map((outcome) => (outcome.kind === "reverted" ? [outcome.id, outcome.error, outcome.disposition] : outcome))).toEqual([
      [ids.notDue, "NotDue", "retryable"],
      [ids.cancelled, "MandateIsCancelled", "terminal"],
      [ids.expiring, "MandateExpired", "terminal"],
      [999n, "UnknownMandate", "terminal"],
    ]);
  });
});
