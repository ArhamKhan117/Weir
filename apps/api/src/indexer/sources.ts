/**
 * Where the indexer's logs come from: the RPC, and Envio HyperSync for catch-up.
 *
 * The RPC is the chain's own view and always answers the head, the live window near it, and any
 * range HyperSync could not. It serves `eth_getLogs` in chunks of `logChunkBlocks` (100 on Monad's
 * public endpoint). HyperSync is an archive: one request covers a hundred thousand blocks, which
 * turns a cold start from thousands of RPC calls into a handful. It lags the head by a few
 * seconds, which is why the indexer never asks it for the live window.
 *
 * A source returns every watched log in `[from, to]` or throws. Never a partial range: the indexer
 * advances its cursor past `to` on the strength of the answer. So the HyperSync adapter pages until
 * the archive confirms it passed `to`, and refuses when the archive's height stops short. The RPC
 * cannot make that promise on its own (a load-balanced backend behind the head answers an empty
 * list), which is what the indexer's re-scan window and its hash-confirmed removals are for.
 */

import { getAddress, toHex, type Address, type Hex, type PublicClient } from "viem";

import { WATCHED_TOPICS, type RawLog } from "./events.js";

export interface LogBatch {
  logs: RawLog[];
  /** Block timestamps the source saw on the way, in unix seconds. May be partial. */
  blockTimes: Map<number, number>;
}

export interface LogSource {
  readonly name: "rpc" | "hypersync";
  getLogs(fromBlock: number, toBlock: number): Promise<LogBatch>;
}

const byPosition = (a: RawLog, b: RawLog): number => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;

/*//////////////////////////////////////////////////////////////
                                  RPC
//////////////////////////////////////////////////////////////*/

interface RpcLogShape {
  removed?: boolean;
  logIndex: Hex | null;
  transactionHash: Hex | null;
  blockHash: Hex | null;
  blockNumber: Hex | null;
  address: Address;
  data: Hex;
  topics: Hex[];
}

export class RpcLogSource implements LogSource {
  readonly name = "rpc" as const;
  readonly #times = new Map<number, number>();

  constructor(
    private readonly client: PublicClient,
    private readonly hub: Address,
    readonly chunkBlocks: number,
  ) {}

  async head(): Promise<number> {
    return Number(await this.client.getBlockNumber({ cacheTime: 0 }));
  }

  async getLogs(fromBlock: number, toBlock: number): Promise<LogBatch> {
    const logs: RawLog[] = [];
    for (let start = fromBlock; start <= toBlock; start += this.chunkBlocks) {
      const end = Math.min(toBlock, start + this.chunkBlocks - 1);
      const page = (await this.client.request({
        method: "eth_getLogs",
        params: [{ address: this.hub, fromBlock: toHex(start), toBlock: toHex(end), topics: [[...WATCHED_TOPICS]] }],
      })) as unknown as RpcLogShape[];
      for (const log of page) {
        if (log.removed === true) continue;
        if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
          throw new Error(`eth_getLogs returned a pending log for blocks ${start}..${end}`);
        }
        logs.push({
          blockNumber: Number(log.blockNumber),
          blockHash: log.blockHash.toLowerCase() as Hex,
          transactionHash: log.transactionHash.toLowerCase() as Hex,
          logIndex: Number(log.logIndex),
          address: getAddress(log.address),
          topics: log.topics.map((topic) => topic.toLowerCase() as Hex),
          data: log.data,
        });
      }
    }
    return { logs: logs.sort(byPosition), blockTimes: new Map() };
  }

  /**
   * The canonical hash at `blockNumber`, or `undefined` when this node has not reached it. Used
   * only to confirm a reorganisation before anything stored is removed.
   */
  async blockHash(blockNumber: number): Promise<Hex | undefined> {
    try {
      const block = await this.client.getBlock({ blockNumber: BigInt(blockNumber) });
      return block.hash === null ? undefined : (block.hash.toLowerCase() as Hex);
    } catch {
      // Not found, or not answerable right now: either way nothing is confirmed, so nothing goes.
      return undefined;
    }
  }

  /** A block's timestamp, cached. */
  async blockTime(blockNumber: number): Promise<number> {
    const cached = this.#times.get(blockNumber);
    if (cached !== undefined) return cached;
    const block = await this.client.getBlock({ blockNumber: BigInt(blockNumber) });
    const seconds = Number(block.timestamp);
    if (this.#times.size >= 10_000) this.#times.clear();
    this.#times.set(blockNumber, seconds);
    return seconds;
  }
}

/*//////////////////////////////////////////////////////////////
                               HYPERSYNC
//////////////////////////////////////////////////////////////*/

/** The part of `@envio-dev/hypersync-client` this module calls. Structural, so tests can fake it. */
export interface HyperSyncQueryClient {
  getHeight(): Promise<number>;
  get(query: {
    fromBlock: number;
    toBlock?: number;
    logs: { address: string[]; topics: string[][] }[];
    fieldSelection: { log: HyperSyncLogField[]; block: HyperSyncBlockField[] };
  }): Promise<{
    nextBlock: number;
    archiveHeight?: number;
    data: {
      logs: {
        removed?: boolean;
        logIndex?: number;
        transactionHash?: string;
        blockHash?: string;
        blockNumber?: number;
        address?: string;
        data?: string;
        topics: (string | undefined | null)[];
      }[];
      blocks: { number?: number; timestamp?: number }[];
    };
  }>;
}

type HyperSyncLogField = "LogIndex" | "TransactionHash" | "BlockHash" | "BlockNumber" | "Address" | "Data" | "Topic0" | "Topic1" | "Topic2" | "Topic3";
type HyperSyncBlockField = "Number" | "Timestamp";

const LOG_FIELDS: HyperSyncLogField[] = ["LogIndex", "TransactionHash", "BlockHash", "BlockNumber", "Address", "Data", "Topic0", "Topic1", "Topic2", "Topic3"];
const BLOCK_FIELDS: HyperSyncBlockField[] = ["Number", "Timestamp"];

/** The real client. Loaded lazily: it is a native module, needed only when HyperSync is configured. */
export async function createHyperSyncClient(url: string, apiToken: string): Promise<HyperSyncQueryClient> {
  const { HypersyncClient } = await import("@envio-dev/hypersync-client");
  const client = new HypersyncClient({
    url,
    apiToken,
    // A failed range falls back to the RPC, so a slow archive should cost seconds, not the
    // default dozen retries with backoff.
    httpReqTimeoutMillis: 15_000,
    maxNumRetries: 2,
  });
  return {
    getHeight: () => client.getHeight(),
    get: (query) => client.get(query),
  };
}

const MAX_PAGES = 1_000;

export class HyperSyncLogSource implements LogSource {
  readonly name = "hypersync" as const;

  constructor(
    private readonly client: HyperSyncQueryClient,
    private readonly hub: Address,
  ) {}

  async getLogs(fromBlock: number, toBlock: number): Promise<LogBatch> {
    const logs: RawLog[] = [];
    const blockTimes = new Map<number, number>();
    let cursor = fromBlock;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.client.get({
        fromBlock: cursor,
        // Exclusive on HyperSync's side.
        toBlock: toBlock + 1,
        logs: [{ address: [this.hub.toLowerCase()], topics: [[...WATCHED_TOPICS]] }],
        fieldSelection: { log: LOG_FIELDS, block: BLOCK_FIELDS },
      });
      for (const block of response.data.blocks) {
        if (block.number !== undefined && block.timestamp !== undefined) blockTimes.set(block.number, Number(block.timestamp));
      }
      for (const log of response.data.logs) {
        if (log.removed === true) continue;
        logs.push(fromHyperSync(log));
      }
      if (response.nextBlock > toBlock) return { logs: logs.sort(byPosition), blockTimes };
      if (response.archiveHeight !== undefined && response.nextBlock > response.archiveHeight) {
        throw new Error(`hypersync: the archive is at block ${response.archiveHeight}, short of ${toBlock}`);
      }
      if (response.nextBlock <= cursor) throw new Error(`hypersync: no progress past block ${cursor}`);
      cursor = response.nextBlock;
    }
    throw new Error(`hypersync: blocks ${fromBlock}..${toBlock} did not complete in ${MAX_PAGES} pages`);
  }
}

function fromHyperSync(log: Awaited<ReturnType<HyperSyncQueryClient["get"]>>["data"]["logs"][number]): RawLog {
  const need = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) throw new Error(`hypersync: a log arrived without ${name}`);
    return value;
  };
  const topics: Hex[] = [];
  for (const topic of log.topics) {
    if (topic === undefined || topic === null) break;
    topics.push(topic.toLowerCase() as Hex);
  }
  return {
    blockNumber: need(log.blockNumber, "blockNumber"),
    blockHash: need(log.blockHash, "blockHash").toLowerCase() as Hex,
    transactionHash: need(log.transactionHash, "transactionHash").toLowerCase() as Hex,
    logIndex: need(log.logIndex, "logIndex"),
    address: getAddress(need(log.address, "address")),
    topics,
    data: need(log.data, "data") as Hex,
  };
}
