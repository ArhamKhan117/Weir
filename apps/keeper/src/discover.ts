/**
 * Step one: the working set of live mandate ids, rebuilt from the hub's logs and kept with a
 * persisted cursor so a restart resumes where the last run stopped.
 *
 * The hub keeps no list of mandates, so the working set is event-sourced: `MandateCreated` adds
 * an id, `MandateCancelled` removes it, in chain order. The filter and the charge step drop ids
 * that can never be charged again (expired, spent, terminal reverts) through
 * {@link MandateCursor.drop}.
 *
 * The cursor is a cache of what the chain already says, never a source of truth. A missing,
 * unreadable or foreign cursor (another chain, another hub, another start block) is a full
 * rescan from the deployment's start block, which with HyperSync is one request.
 *
 * The ids and the scanned block live in one file written atomically, so the disk can only ever
 * hold a block height together with the ids from every block up to it. The scan reads to the
 * head but commits the block {@link CONFIRMATION_BLOCKS} behind it, so the last few blocks are
 * read again next pass and a short reorganisation is picked up rather than skipped.
 */

import { readFile } from "node:fs/promises";
import { getAddress, type Address } from "viem";
import { SerialFileWriter, isEnoent } from "@weir/shared/fs";
import type { HistorySource, HubLog } from "./history.js";
import type { Logger } from "./log.js";

export const CURSOR_VERSION = 2;

/** Blocks behind the head the cursor is committed at. The tail is re-read every pass. */
export const CONFIRMATION_BLOCKS = 3n;

/** What a cursor must belong to. A file written for anything else is ignored. */
export interface CursorIdentity {
  readonly chainId: number;
  readonly hub: Address;
  readonly startBlock: bigint;
}

/** How the cursor loaded, in words, for the startup line. */
export function describeCursor(cursor: MandateCursor): string {
  const { outcome, identity } = cursor;
  if (outcome.kind === "fresh") return `no cursor at ${cursor.filePath}; scanning from block ${identity.startBlock}`;
  if (outcome.kind === "rebuilt") {
    return `ignoring the cursor at ${cursor.filePath} (${outcome.reason}); scanning from block ${identity.startBlock}`;
  }
  return `cursor at ${cursor.filePath}: block ${outcome.lastScannedBlock}, ${outcome.ids} mandate(s)`;
}

export type CursorOutcome =
  | { readonly kind: "fresh" }
  | { readonly kind: "resumed"; readonly lastScannedBlock: bigint; readonly ids: number }
  | { readonly kind: "rebuilt"; readonly reason: string };

interface CursorFile {
  version: number;
  chainId: number;
  hub: string;
  startBlock: string;
  lastScannedBlock: string;
  mandateIds: string[];
}

export class MandateCursor {
  readonly filePath: string;
  readonly identity: CursorIdentity;
  readonly outcome: CursorOutcome;
  #lastScannedBlock: bigint | undefined;
  readonly #ids: Set<bigint>;
  readonly #writer: SerialFileWriter;

  private constructor(
    filePath: string,
    identity: CursorIdentity,
    outcome: CursorOutcome,
    lastScannedBlock: bigint | undefined,
    ids: Iterable<bigint>,
  ) {
    this.filePath = filePath;
    this.identity = identity;
    this.outcome = outcome;
    this.#lastScannedBlock = lastScannedBlock;
    this.#ids = new Set(ids);
    this.#writer = new SerialFileWriter(filePath);
  }

  /**
   * Load the cursor at `filePath`. Never throws for a missing, malformed or foreign file: each
   * is an empty cursor whose {@link outcome} says why. An error reading the file for another
   * reason, such as permissions, still throws, because a rescan would not fix it.
   */
  static async open(filePath: string, identity: CursorIdentity): Promise<MandateCursor> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) return new MandateCursor(filePath, identity, { kind: "fresh" }, undefined, []);
      throw error;
    }
    const parsed = parseCursor(raw, identity);
    if (typeof parsed === "string") {
      return new MandateCursor(filePath, identity, { kind: "rebuilt", reason: parsed }, undefined, []);
    }
    return new MandateCursor(
      filePath,
      identity,
      { kind: "resumed", lastScannedBlock: parsed.lastScannedBlock, ids: parsed.ids.length },
      parsed.lastScannedBlock,
      parsed.ids,
    );
  }

  /** The highest block whose logs are all applied, or `undefined` before the first scan. */
  get lastScannedBlock(): bigint | undefined {
    return this.#lastScannedBlock;
  }

  /** The working set, ascending. */
  get ids(): bigint[] {
    return [...this.#ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  get size(): number {
    return this.#ids.size;
  }

  has(id: bigint): boolean {
    return this.#ids.has(id);
  }

  /**
   * Apply logs in chain order, move the scanned block forward to `scannedTo` (never back), and
   * persist both in one write. On a failed write the in-memory state is rolled back to match
   * the disk.
   *
   * @returns the ids this call added to the set and the ids it removed, so a caller reports
   *          what changed rather than every log in a range it read twice.
   */
  async apply(logs: readonly HubLog[], scannedTo: bigint | undefined): Promise<{ added: bigint[]; removed: bigint[] }> {
    const before = { block: this.#lastScannedBlock, ids: new Set(this.#ids) };
    for (const log of logs) {
      if (log.kind === "created") this.#ids.add(log.mandateId);
      else this.#ids.delete(log.mandateId);
    }
    const added = [...this.#ids].filter((id) => !before.ids.has(id));
    const removed = [...before.ids].filter((id) => !this.#ids.has(id));
    if (scannedTo !== undefined && (this.#lastScannedBlock === undefined || scannedTo > this.#lastScannedBlock)) {
      this.#lastScannedBlock = scannedTo;
    }
    try {
      await this.#persist();
    } catch (error) {
      this.#lastScannedBlock = before.block;
      this.#ids.clear();
      for (const id of before.ids) this.#ids.add(id);
      throw error;
    }
    return { added, removed };
  }

  /** Remove ids for good and persist. Returns the ids that were present. */
  async drop(ids: Iterable<bigint>): Promise<bigint[]> {
    const removed = [...ids].filter((id) => this.#ids.delete(id));
    if (removed.length === 0) return removed;
    try {
      await this.#persist();
    } catch (error) {
      for (const id of removed) this.#ids.add(id);
      throw error;
    }
    return removed;
  }

  /** Resolves once every queued write has settled. */
  settle(): Promise<void> {
    return this.#writer.settle();
  }

  #persist(): Promise<void> {
    const file: CursorFile = {
      version: CURSOR_VERSION,
      chainId: this.identity.chainId,
      hub: this.identity.hub,
      startBlock: this.identity.startBlock.toString(),
      lastScannedBlock: (this.#lastScannedBlock ?? this.identity.startBlock - 1n).toString(),
      mandateIds: this.ids.map(String),
    };
    return this.#writer.write(`${JSON.stringify(file, null, 2)}\n`);
  }
}

/** The cursor's contents, or the reason it cannot be used. */
function parseCursor(raw: string, identity: CursorIdentity): { lastScannedBlock: bigint; ids: bigint[] } | string {
  let file: Partial<CursorFile>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return "the file is not a JSON object";
    file = parsed as Partial<CursorFile>;
  } catch {
    return "the file is not valid JSON";
  }
  if (file.version !== CURSOR_VERSION) return `version ${String(file.version)} is not ${CURSOR_VERSION}`;
  if (file.chainId !== identity.chainId) return `it was written for chain ${String(file.chainId)}`;
  if (typeof file.hub !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(file.hub) || getAddress(file.hub) !== getAddress(identity.hub)) {
    return `it was written for hub ${String(file.hub)}`;
  }
  if (file.startBlock !== identity.startBlock.toString()) return `it was written for start block ${String(file.startBlock)}`;
  if (typeof file.lastScannedBlock !== "string" || !/^\d+$/.test(file.lastScannedBlock)) {
    return "lastScannedBlock is not a block number";
  }
  if (!Array.isArray(file.mandateIds) || !file.mandateIds.every((id) => typeof id === "string" && /^\d+$/.test(id))) {
    return "mandateIds is not a list of ids";
  }
  return { lastScannedBlock: BigInt(file.lastScannedBlock), ids: file.mandateIds.map((id) => BigInt(id)) };
}

export interface DiscoverOptions {
  readonly cursor: MandateCursor;
  readonly history: Pick<HistorySource, "readSegment">;
  /** The chain head, read from the RPC. */
  readonly head: bigint;
  readonly confirmations?: bigint;
  readonly log: Logger;
}

export interface DiscoverResult {
  /** First block read this pass, or `undefined` when the cursor was already at the head. */
  readonly fromBlock: bigint | undefined;
  readonly toBlock: bigint;
  /** Ids this pass added to the working set. */
  readonly added: bigint[];
  /** Ids this pass removed from it because their `MandateCancelled` log was read. */
  readonly cancelled: bigint[];
  readonly via: ReadonlyArray<"hypersync" | "rpc">;
}

/**
 * Read every hub log from the block after the cursor (or the start block) to the head, a
 * segment at a time, applying and committing each segment before the next, so a failure part
 * way keeps what was read.
 */
export async function discover(options: DiscoverOptions): Promise<DiscoverResult> {
  const { cursor, history, head, log } = options;
  const safe = head - (options.confirmations ?? CONFIRMATION_BLOCKS);
  const { startBlock } = cursor.identity;
  const last = cursor.lastScannedBlock;
  let from = last === undefined || last < startBlock ? startBlock : last + 1n;

  const added: bigint[] = [];
  const cancelled: bigint[] = [];
  const via = new Set<"hypersync" | "rpc">();
  if (from > head) return { fromBlock: undefined, toBlock: head, added, cancelled, via: [] };
  const fromBlock = from;
  if (head - from > 1_000n) log.info(`reading hub logs for blocks ${from}-${head}`);

  while (from <= head) {
    const segment = await history.readSegment(from, head);
    const scannedTo = segment.toBlock <= safe ? segment.toBlock : safe >= from ? safe : undefined;
    const change = await cursor.apply(segment.logs, scannedTo);
    added.push(...change.added);
    cancelled.push(...change.removed);
    via.add(segment.via);
    from = segment.toBlock + 1n;
  }

  return { fromBlock, toBlock: head, added, cancelled, via: [...via] };
}
