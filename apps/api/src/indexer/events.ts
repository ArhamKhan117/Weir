/**
 * The hub events the indexer reads, and how a raw log becomes one.
 *
 * Seven events, every one that changes what a mandate is or what it has paid: creation, the two
 * charge outcomes, the three lifecycle changes and the manager change. `NonceInvalidated` names no
 * mandate and is not read. Logs are decoded against the generated ABI with `strict`, so a log
 * whose data does not match its signature is skipped rather than stored half-read.
 */

import { mandateHubAbi } from "@weir/shared";
import {
  decodeEventLog,
  getAbiItem,
  getAddress,
  toEventSelector,
  type AbiEvent,
  type Address,
  type DecodeEventLogReturnType,
  type Hex,
} from "viem";

export const WATCHED_EVENTS = [
  "MandateCreated",
  "Charged",
  "ChargeFailed",
  "MandateCancelled",
  "MandatePaused",
  "MandateResumed",
  "ManagerChanged",
] as const;

export type WatchedEvent = (typeof WATCHED_EVENTS)[number];

/** topic0 of every watched event, for the log filter. */
export const WATCHED_TOPICS: readonly Hex[] = WATCHED_EVENTS.map((name) =>
  toEventSelector(getAbiItem({ abi: mandateHubAbi, name }) as AbiEvent),
);

/** A log as both sources deliver it. */
export interface RawLog {
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

export type HubEvent = Extract<DecodeEventLogReturnType<typeof mandateHubAbi>, { eventName: WatchedEvent }>;

export interface DecodedLog {
  log: RawLog;
  event: HubEvent;
}

const WATCHED = new Set<string>(WATCHED_EVENTS);

/** The watched event in `log`, or `undefined` for anything else. */
export function decodeHubLog(log: RawLog): HubEvent | undefined {
  const [topic0, ...rest] = log.topics;
  if (topic0 === undefined || !WATCHED_TOPICS.includes(topic0)) return undefined;
  try {
    const decoded = decodeEventLog({ abi: mandateHubAbi, data: log.data, topics: [topic0, ...rest], strict: true });
    return WATCHED.has(decoded.eventName) ? (decoded as HubEvent) : undefined;
  } catch {
    return undefined;
  }
}

/** The mandate an event is about. */
export function mandateIdOf(event: HubEvent): bigint {
  return event.args.mandateId;
}

/** The event's arguments as JSON: `bigint` as decimal strings, addresses checksummed. */
export function argsJson(event: HubEvent): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(event.args as Record<string, unknown>)) {
    if (typeof value === "bigint") out[key] = value.toString();
    else if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) out[key] = getAddress(value);
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else out[key] = String(value);
  }
  return out;
}

/** Stable across re-reads and restarts: where the log sits in the chain. */
export function eventId(chainId: number, log: Pick<RawLog, "transactionHash" | "logIndex">): string {
  return `evt_${chainId}_${log.transactionHash.toLowerCase()}_${log.logIndex}`;
}
