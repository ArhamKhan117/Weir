import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, zeroAddress, type Address, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mandateHubAbi } from "@weir/shared";
import { discover, MandateCursor, type CursorIdentity } from "./discover.js";
import {
  createHyperSyncReader,
  createRpcReader,
  decodeArchiveLog,
  HistorySource,
  type HubLog,
  type HyperSyncQuery,
  type HyperSyncQueryClient,
  type HyperSyncResponse,
  type LogReader,
} from "./history.js";
import { createMemoryLogger, silentLogger } from "./log.js";

const HUB: Address = "0x1111111111111111111111111111111111111111";
const identity: CursorIdentity = { chainId: 10143, hub: HUB, startBlock: 1_000n };

const created = (mandateId: bigint, blockNumber: bigint, logIndex = 0): HubLog => ({ kind: "created", mandateId, blockNumber, logIndex });
const cancelled = (mandateId: bigint, blockNumber: bigint, logIndex = 0): HubLog => ({ kind: "cancelled", mandateId, blockNumber, logIndex });

/** A chain of hub logs a reader answers from, recording every range it was asked for. */
function scriptedReader(logs: HubLog[]): LogReader & { ranges: string[] } {
  const ranges: string[] = [];
  return {
    ranges,
    getLogs: async (from, to) => {
      ranges.push(`${from}-${to}`);
      return logs.filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to);
    },
  };
}

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "weir-keeper-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("discover", () => {
  const chain = [created(1n, 1_000n), created(2n, 1_050n), created(3n, 1_120n), cancelled(2n, 1_130n), created(4n, 1_205n)];

  it("builds the working set from creations and cancellations, and commits behind the head", async () => {
    const path = join(directory, "cursor.json");
    const cursor = await MandateCursor.open(path, identity);
    expect(cursor.outcome).toEqual({ kind: "fresh" });

    const rpc = scriptedReader(chain);
    const history = new HistorySource({ rpc, rpcChunkBlocks: 100, chainId: 10143, log: silentLogger });
    const result = await discover({ cursor, history, head: 1_210n, log: silentLogger });

    expect(rpc.ranges).toEqual(["1000-1210"]);
    expect(result.added).toEqual([1n, 3n, 4n]);
    expect(cursor.ids).toEqual([1n, 3n, 4n]);
    expect(cursor.lastScannedBlock).toBe(1_207n);

    const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(file).toEqual({
      version: 2,
      chainId: 10143,
      hub: HUB,
      startBlock: "1000",
      lastScannedBlock: "1207",
      mandateIds: ["1", "3", "4"],
    });
  });

  it("resumes after the committed block and reads the unconfirmed tail again", async () => {
    const path = join(directory, "cursor.json");
    const rpc = scriptedReader([...chain, cancelled(4n, 1_215n)]);
    const history = new HistorySource({ rpc, rpcChunkBlocks: 100, chainId: 10143, log: silentLogger });
    await discover({ cursor: await MandateCursor.open(path, identity), history, head: 1_210n, log: silentLogger });

    const resumed = await MandateCursor.open(path, identity);
    expect(resumed.outcome).toEqual({ kind: "resumed", lastScannedBlock: 1_207n, ids: 3 });
    const result = await discover({ cursor: resumed, history, head: 1_220n, log: silentLogger });
    expect(rpc.ranges.at(-1)).toBe("1208-1220");
    expect(result.added).toEqual([]);
    expect(result.cancelled).toEqual([4n]);
    expect(resumed.ids).toEqual([1n, 3n]);
  });

  it("rebuilds the same working set when the cursor file is deleted", async () => {
    const path = join(directory, "cursor.json");
    const history = new HistorySource({ rpc: scriptedReader(chain), rpcChunkBlocks: 100, chainId: 10143, log: silentLogger });
    const first = await MandateCursor.open(path, identity);
    await discover({ cursor: first, history, head: 1_300n, log: silentLogger });
    await first.drop([3n]);
    await rm(path);

    const rebuilt = await MandateCursor.open(path, identity);
    expect(rebuilt.outcome).toEqual({ kind: "fresh" });
    await discover({ cursor: rebuilt, history, head: 1_300n, log: silentLogger });
    expect(rebuilt.ids).toEqual([1n, 3n, 4n]);
  });

  it("ignores a cursor that is unreadable or was written for another hub", async () => {
    const path = join(directory, "cursor.json");
    await writeFile(path, "{ not json");
    expect((await MandateCursor.open(path, identity)).outcome).toEqual({ kind: "rebuilt", reason: "the file is not valid JSON" });

    const history = new HistorySource({ rpc: scriptedReader(chain), rpcChunkBlocks: 100, chainId: 10143, log: silentLogger });
    await discover({ cursor: await MandateCursor.open(path, identity), history, head: 1_300n, log: silentLogger });
    const foreign = await MandateCursor.open(path, { ...identity, hub: "0x9999999999999999999999999999999999999999" });
    expect(foreign.outcome.kind).toBe("rebuilt");
    expect(foreign.ids).toEqual([]);
  });

  it("does nothing when the cursor is already at the head", async () => {
    const path = join(directory, "cursor.json");
    const rpc = scriptedReader(chain);
    const history = new HistorySource({ rpc, rpcChunkBlocks: 100, chainId: 10143, log: silentLogger });
    const cursor = await MandateCursor.open(path, identity);
    await discover({ cursor, history, head: 1_300n, log: silentLogger, confirmations: 0n });
    const result = await discover({ cursor, history, head: 1_300n, log: silentLogger, confirmations: 0n });
    expect(result.fromBlock).toBeUndefined();
    expect(rpc.ranges).toEqual(["1000-1300"]);
  });
});

describe("HistorySource", () => {
  const chain = [created(1n, 1_000n), created(2n, 5_000n), created(3n, 9_950n)];

  function archiveClient(chainId = 10143): Pick<HyperSyncQueryClient, "getChainId"> {
    return { getChainId: async () => chainId };
  }

  it("reads history from the archive and the live window from the RPC", async () => {
    const rpc = scriptedReader(chain);
    const archive = scriptedReader(chain);
    const history = new HistorySource({
      rpc,
      rpcChunkBlocks: 100,
      archive: { reader: archive, client: archiveClient() },
      chainId: 10143,
      log: silentLogger,
    });
    const cursor = await MandateCursor.open(join(directory, "cursor.json"), identity);
    const result = await discover({ cursor, history, head: 10_000n, log: silentLogger });

    expect(archive.ranges).toEqual(["1000-9700"]);
    expect(rpc.ranges).toEqual(["9701-10000"]);
    expect(result.via).toEqual(["hypersync", "rpc"]);
    expect(cursor.ids).toEqual([1n, 2n, 3n]);
  });

  it("falls back to the RPC when the archive fails, and rests the archive", async () => {
    let now = 0;
    const rpc = scriptedReader(chain);
    const log = createMemoryLogger();
    const history = new HistorySource({
      rpc,
      rpcChunkBlocks: 100,
      archive: { reader: { getLogs: async () => Promise.reject(new Error("401 unauthorized")) }, client: archiveClient() },
      chainId: 10143,
      now: () => now,
      log,
    });
    const segment = await history.readSegment(1_000n, 10_000n);
    expect(segment).toMatchObject({ toBlock: 1_999n, via: "rpc" });
    expect(log.lines[0]).toMatch(/HyperSync failed for blocks 1000-9700 \(401 unauthorized\); reading from the RPC/);

    now = 1_000;
    expect((await history.readSegment(2_000n, 10_000n)).via).toBe("rpc");
    expect(log.lines).toHaveLength(1);
  });

  it("switches the archive off when it serves another chain", async () => {
    const archive = scriptedReader(chain);
    const log = createMemoryLogger();
    const history = new HistorySource({
      rpc: scriptedReader(chain),
      rpcChunkBlocks: 100,
      archive: { reader: archive, client: archiveClient(143) },
      chainId: 10143,
      log,
    });
    expect((await history.readSegment(1_000n, 10_000n)).via).toBe("rpc");
    expect(archive.ranges).toEqual([]);
    expect(log.lines[0]).toMatch(/serves chain 143, not 10143/);
  });
});

describe("createRpcReader", () => {
  it("reads in chunks the endpoint accepts", async () => {
    const ranges: string[] = [];
    const client = {
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push(`${fromBlock}-${toBlock}`);
        return [];
      },
    };
    await createRpcReader(client as never, HUB, 100).getLogs(1_000n, 1_250n);
    expect(ranges).toEqual(["1000-1099", "1100-1199", "1200-1250"]);
  });
});

describe("HyperSync reader", () => {
  const createdEvent = getAbiItem({ abi: mandateHubAbi, name: "MandateCreated" });

  function archiveLog(mandateId: bigint, blockNumber: number) {
    const topics = encodeEventTopics({
      abi: mandateHubAbi,
      eventName: "MandateCreated",
      args: { mandateId, payer: "0x2222222222222222222222222222222222222222", merchant: "0x3333333333333333333333333333333333333333" },
    }) as Hex[];
    const data = encodeAbiParameters(
      createdEvent.inputs.filter((input) => !input.indexed),
      [zeroAddress, zeroAddress, zeroAddress, 1n, 60, 1n, 1n, 1n, 2n, `0x${"00".repeat(32)}`],
    );
    return { blockNumber, logIndex: 0, address: HUB.toLowerCase(), data, topics };
  }

  function scriptedArchive(pages: HyperSyncResponse[]): HyperSyncQueryClient & { queries: HyperSyncQuery[] } {
    const queries: HyperSyncQuery[] = [];
    return {
      queries,
      getChainId: async () => 10143,
      get: async (query) => {
        queries.push(query);
        const page = pages.shift();
        if (page === undefined) throw new Error("no more pages");
        return page;
      },
    };
  }

  it("pages until the archive confirms the whole range", async () => {
    const client = scriptedArchive([
      { nextBlock: 1_500, archiveHeight: 9_000, data: { logs: [archiveLog(1n, 1_200)] } },
      { nextBlock: 2_001, archiveHeight: 9_000, data: { logs: [archiveLog(2n, 1_800)] } },
    ]);
    const logs = await createHyperSyncReader(client, HUB).getLogs(1_000n, 2_000n);
    expect(logs.map((entry) => [entry.mandateId, entry.blockNumber])).toEqual([
      [1n, 1_200n],
      [2n, 1_800n],
    ]);
    expect(client.queries.map((query) => [query.fromBlock, query.toBlock])).toEqual([
      [1_000, 2_001],
      [1_500, 2_001],
    ]);
  });

  it("refuses a range the archive has not reached", async () => {
    const client = scriptedArchive([{ nextBlock: 1_500, archiveHeight: 1_499, data: { logs: [] } }]);
    await expect(createHyperSyncReader(client, HUB).getLogs(1_000n, 2_000n)).rejects.toThrow(/short of 2000/);
  });

  it("decodes a created log and refuses one from another contract", () => {
    expect(decodeArchiveLog(archiveLog(7n, 42), HUB.toLowerCase())).toEqual(created(7n, 42n));
    expect(() => decodeArchiveLog({ ...archiveLog(7n, 42), address: "0x9999999999999999999999999999999999999999" }, HUB.toLowerCase())).toThrow(
      /not the hub/,
    );
  });
});
