/**
 * The hub's `MandateCreated` and `MandateCancelled` logs over a block range, from the RPC or
 * from Envio HyperSync.
 *
 * Monad's public RPC answers `eth_getLogs` over at most 100 blocks, so rebuilding the working
 * set from the deployment block is one request per hundred blocks. HyperSync serves the same
 * logs from an archive in one request per range, paginated by the `nextBlock` it returns. The
 * archive lags the chain by a few seconds, so three things stay on the RPC: the head, the last
 * {@link LIVE_WINDOW_BLOCKS} blocks, and any range the archive failed on.
 *
 * Every reader here returns the complete set of logs for the range it was asked, or throws.
 * Discovery advances its cursor past every range it reads, so a partial answer would lose
 * mandates silently.
 */

import { decodeEventLog, getAbiItem, toEventSelector, type Address, type Hex, type PublicClient } from "viem";
import { mandateHubAbi, type Secret } from "@weir/shared";
import { describeError, type Logger } from "./log.js";

export const mandateCreatedEvent = getAbiItem({ abi: mandateHubAbi, name: "MandateCreated" });
export const mandateCancelledEvent = getAbiItem({ abi: mandateHubAbi, name: "MandateCancelled" });
const HUB_EVENTS = [mandateCreatedEvent, mandateCancelledEvent] as const;
const HUB_TOPICS = HUB_EVENTS.map((event) => toEventSelector(event));

/** Ranges ending within this many blocks of the head are read from the RPC, never the archive. */
export const LIVE_WINDOW_BLOCKS = 300n;

/** RPC chunks read per segment, so a cold rebuild without HyperSync commits every 1,000 blocks. */
export const RPC_CHUNKS_PER_SEGMENT = 10n;

/** How long the archive is rested after it fails, before it is tried again. */
export const ARCHIVE_REST_MS = 60_000;

/** A lifecycle log that changes the working set. */
export interface HubLog {
  readonly kind: "created" | "cancelled";
  readonly mandateId: bigint;
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

/** Every hub log in `[fromBlock, toBlock]`, in chain order, or a thrown error. Never a partial range. */
export interface LogReader {
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<HubLog[]>;
}

function byChainOrder(a: HubLog, b: HubLog): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

/*//////////////////////////////////////////////////////////////
                                RPC
//////////////////////////////////////////////////////////////*/

/**
 * `eth_getLogs` in chunks of `chunkBlocks`, each retried once, since a public endpoint that
 * throttles a burst usually answers the same request a moment later.
 */
export function createRpcReader(client: Pick<PublicClient, "getLogs">, hub: Address, chunkBlocks: number): LogReader {
  const span = BigInt(chunkBlocks);
  const readChunk = async (fromBlock: bigint, toBlock: bigint): Promise<HubLog[]> => {
    const logs = await client.getLogs({ address: hub, events: HUB_EVENTS, fromBlock, toBlock, strict: true });
    return logs.map((log) => {
      if (log.blockNumber === null || log.logIndex === null) {
        throw new Error(`a hub log in blocks ${fromBlock}-${toBlock} arrived without its position`);
      }
      return {
        kind: log.eventName === "MandateCreated" ? "created" : "cancelled",
        mandateId: log.args.mandateId,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      };
    });
  };

  return {
    async getLogs(fromBlock, toBlock) {
      const out: HubLog[] = [];
      for (let start = fromBlock; start <= toBlock; start += span) {
        const end = start + span - 1n < toBlock ? start + span - 1n : toBlock;
        try {
          out.push(...(await readChunk(start, end)));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250));
          out.push(...(await readChunk(start, end)));
        }
      }
      return out.sort(byChainOrder);
    },
  };
}

/*//////////////////////////////////////////////////////////////
                             HYPERSYNC
//////////////////////////////////////////////////////////////*/

/** The log fields read from the archive, named as HyperSync names them. */
const LOG_FIELDS = ["BlockNumber", "LogIndex", "Address", "Data", "Topic0", "Topic1", "Topic2", "Topic3"] as const;

export interface HyperSyncLog {
  readonly blockNumber?: number | undefined;
  readonly logIndex?: number | undefined;
  readonly address?: string | undefined;
  readonly data?: string | undefined;
  readonly topics: ReadonlyArray<string | undefined | null>;
}

export interface HyperSyncQuery {
  readonly fromBlock: number;
  /** Exclusive, as HyperSync defines it. */
  readonly toBlock: number;
  readonly logs: ReadonlyArray<{ readonly address: readonly string[]; readonly topics: ReadonlyArray<readonly string[]> }>;
  readonly fieldSelection: { readonly log: readonly string[] };
}

export interface HyperSyncResponse {
  readonly nextBlock: number;
  readonly archiveHeight?: number | undefined;
  readonly data: { readonly logs: readonly HyperSyncLog[] };
}

/** The two calls made to the archive. Structural, so tests drive the reader with a script. */
export interface HyperSyncQueryClient {
  getChainId(): Promise<number>;
  get(query: HyperSyncQuery): Promise<HyperSyncResponse>;
}

/**
 * The real client. Imported lazily: it is a native module, and a keeper that reads history from
 * the RPC should not need it to load.
 */
export async function createHyperSyncClient(url: string, token: Secret): Promise<HyperSyncQueryClient> {
  const { HypersyncClient } = await import("@envio-dev/hypersync-client");
  const client = new HypersyncClient({
    url,
    apiToken: token.reveal(),
    // The source falls back to the RPC on failure, so a slow archive should cost seconds.
    httpReqTimeoutMillis: 15_000,
    maxNumRetries: 2,
  });
  return {
    getChainId: () => client.getChainId(),
    get: (query) =>
      client.get({
        fromBlock: query.fromBlock,
        toBlock: query.toBlock,
        logs: query.logs.map((selection) => ({
          address: [...selection.address],
          topics: selection.topics.map((topic) => [...topic]),
        })),
        fieldSelection: { log: [...query.fieldSelection.log] as (typeof LOG_FIELDS)[number][] },
      }),
  };
}

/** The largest number of pages one range may take before it is treated as runaway. */
const MAX_PAGES = 1_000;

/** Pages through the archive until it confirms the whole range, refusing anything less. */
export function createHyperSyncReader(client: HyperSyncQueryClient, hub: Address): LogReader {
  const address = hub.toLowerCase();
  return {
    async getLogs(fromBlock, toBlock) {
      const out: HubLog[] = [];
      let cursor = Number(fromBlock);
      const last = Number(toBlock);
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await client.get({
          fromBlock: cursor,
          toBlock: last + 1,
          logs: [{ address: [address], topics: [HUB_TOPICS] }],
          fieldSelection: { log: LOG_FIELDS },
        });
        for (const log of response.data.logs) out.push(decodeArchiveLog(log, address));

        if (response.nextBlock > last) return out.sort(byChainOrder);
        if (response.archiveHeight !== undefined && response.archiveHeight < last) {
          throw new Error(`HyperSync has reached block ${response.archiveHeight}, short of ${last}`);
        }
        if (response.nextBlock <= cursor) throw new Error(`HyperSync made no progress past block ${cursor}`);
        cursor = response.nextBlock;
      }
      throw new Error(`HyperSync did not finish blocks ${fromBlock}-${toBlock} in ${MAX_PAGES} pages`);
    },
  };
}

/** One archive log as a {@link HubLog}, or a thrown error naming what it lacked. */
export function decodeArchiveLog(log: HyperSyncLog, hub: string): HubLog {
  if (log.blockNumber === undefined || log.logIndex === undefined || log.data === undefined) {
    throw new Error("HyperSync returned a log without its block, index or data");
  }
  if (log.address !== undefined && log.address.toLowerCase() !== hub) {
    throw new Error(`HyperSync returned a log from ${log.address}, not the hub`);
  }
  const topics: Hex[] = [];
  for (const topic of log.topics) {
    if (topic === undefined || topic === null) break;
    topics.push(topic as Hex);
  }
  const [signature, ...rest] = topics;
  if (signature === undefined) throw new Error("HyperSync returned a log without topics");
  const decoded = decodeEventLog({ abi: HUB_EVENTS, topics: [signature, ...rest], data: log.data as Hex, strict: true });
  return {
    kind: decoded.eventName === "MandateCreated" ? "created" : "cancelled",
    mandateId: decoded.args.mandateId,
    blockNumber: BigInt(log.blockNumber),
    logIndex: log.logIndex,
  };
}

/*//////////////////////////////////////////////////////////////
                         CHOOSING A SOURCE
//////////////////////////////////////////////////////////////*/

export interface HistorySegment {
  /** Last block covered, inclusive. The segment starts where it was asked to. */
  readonly toBlock: bigint;
  readonly logs: HubLog[];
  readonly via: "hypersync" | "rpc";
}

export interface HistorySourceOptions {
  readonly rpc: LogReader;
  readonly rpcChunkBlocks: number;
  /** The archive, with the client it reads through for the chain-id check. */
  readonly archive?: { readonly reader: LogReader; readonly client: Pick<HyperSyncQueryClient, "getChainId"> } | undefined;
  readonly chainId: number;
  readonly liveWindowBlocks?: bigint;
  readonly restMs?: number;
  readonly now?: () => number;
  readonly log: Logger;
}

/**
 * Hands discovery one segment at a time, each from the source that should answer it.
 *
 * A segment that ends more than the live window behind the head goes to the archive, whole;
 * anything else is an RPC segment of {@link RPC_CHUNKS_PER_SEGMENT} chunks. When the archive
 * fails, it is rested for {@link ARCHIVE_REST_MS} and the same start is read from the RPC, so
 * a pass never fails because the fast path did; it only gets slower. An archive that reports a
 * different chain than the keeper's is switched off for good.
 */
export class HistorySource {
  readonly #options: HistorySourceOptions;
  readonly #liveWindow: bigint;
  readonly #rpcSegment: bigint;
  #restingUntil = 0;
  #chainChecked = false;
  #disabled = false;

  constructor(options: HistorySourceOptions) {
    this.#options = options;
    this.#liveWindow = options.liveWindowBlocks ?? LIVE_WINDOW_BLOCKS;
    this.#rpcSegment = BigInt(options.rpcChunkBlocks) * RPC_CHUNKS_PER_SEGMENT;
  }

  /** Which source a cold start would use, for the startup line. */
  get describe(): string {
    return this.#options.archive === undefined || this.#disabled ? "RPC" : "HyperSync, RPC for the head";
  }

  /** Logs from `fromBlock` up to at most `head`. */
  async readSegment(fromBlock: bigint, head: bigint): Promise<HistorySegment> {
    const archiveEnd = head - this.#liveWindow;
    const archive = this.#options.archive;
    const now = this.#options.now ?? Date.now;

    if (archive !== undefined && !this.#disabled && fromBlock <= archiveEnd && now() >= this.#restingUntil) {
      try {
        await this.#checkChain(archive.client);
        if (!this.#disabled) {
          return { toBlock: archiveEnd, logs: await archive.reader.getLogs(fromBlock, archiveEnd), via: "hypersync" };
        }
      } catch (error) {
        this.#restingUntil = now() + (this.#options.restMs ?? ARCHIVE_REST_MS);
        this.#options.log.warn(
          `HyperSync failed for blocks ${fromBlock}-${archiveEnd} (${describeError(error)}); reading from the RPC`,
        );
      }
    }

    const end = fromBlock + this.#rpcSegment - 1n;
    const toBlock = end < head ? end : head;
    return { toBlock, logs: await this.#options.rpc.getLogs(fromBlock, toBlock), via: "rpc" };
  }

  async #checkChain(client: Pick<HyperSyncQueryClient, "getChainId">): Promise<void> {
    if (this.#chainChecked) return;
    const archiveChain = await client.getChainId();
    this.#chainChecked = true;
    if (archiveChain !== this.#options.chainId) {
      this.#disabled = true;
      this.#options.log.error(
        `HYPERSYNC_URL serves chain ${archiveChain}, not ${this.#options.chainId}; reading history from the RPC only`,
      );
    }
  }
}
