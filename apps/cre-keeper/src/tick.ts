/**
 * One tick of the charger workflow, as a function of plain values and three ports.
 *
 * Everything the workflow decides is here: which ids to read, which of them are due, in what
 * order and how many, and how much gas the report may use. The CRE wiring in
 * `weir-charger/workflow.ts` builds the ports from the SDK's EVM client; this module imports
 * nothing, so a Node test drives it with fakes and the WebAssembly build runs it unchanged.
 *
 * The due rules are the off-chain keeper's, so the two agree on what is due:
 *
 * - A periodic mandate is due as soon as the hub says it is chargeable.
 * - A stream accrues every second, so charging it every tick would spend more gas than it
 *   collects. It is due once it is chargeable and one of these holds, whichever comes first: its
 *   quote reaches `streamMinCharge`; its quote has reached what one charge may take
 *   (`maxPerCharge`, or what `maxTotal` has left), since accrual above that is forfeited, not
 *   carried; `streamMaxAgeSeconds` have passed since its checkpoint; or it is within two schedule
 *   intervals of `expiresAt`, since nothing can be charged after it.
 *
 * Every decision is made against the chain's clock at the block the state was read at, never the
 * workflow's. `isChargeable` ignores funding on purpose: a past-due mandate stays chargeable and
 * is retried, which is how it recovers once the payer tops up. Past-due mandates are ordered after
 * healthy ones so they can never crowd a funded mandate out of the batch.
 */

/*//////////////////////////////////////////////////////////////
                              LIMITS
//////////////////////////////////////////////////////////////*/

/**
 * CRE lets one execution make 15 chain reads. One reads the head; the rest read pages. A hub
 * with more pages than this is read a slice per tick, rotating, so every id is still visited.
 */
export const MAX_PAGES_PER_TICK = 14;

/**
 * The gas limit a report is sent with. Monad bills the limit, not the gas used, so the limit is
 * sized from the batch rather than set once high: a base for the transaction, the forwarder and
 * the report's decoding, plus an allowance per mandate that covers a charge drawn from a vault,
 * the most expensive path, at Monad's cold-access prices. The ceiling is CRE's per-transaction
 * gas limit for an EVM write.
 *
 * Measured on Monad Testnet through the simulator's forwarder: a one-mandate report used about
 * 188,000 gas, of which `onReport` charging one mandate from a balance was 108,858. Everything
 * but the charge came to about 90,000; the base allows roughly twice that, because the network's
 * forwarder also verifies the DON's signatures, which the simulator's does not.
 */
export const GAS_BASE = 200_000n;
/**
 * The default allowance per mandate, which covers a charge from Weir's Testnet vault. A charge
 * from a Mainnet Morpho vault measured about 470,000 on a fork, its interest accrual included, so
 * Mainnet sets `gasPerMandate` to 550,000.
 */
export const GAS_PER_MANDATE = 150_000n;
export const GAS_CEILING = 10_000_000n;

/** The largest batch the gas ceiling can carry at `perMandate` gas a mandate. */
export function maxBatchFor(perMandate: bigint): number {
  return Number((GAS_CEILING - GAS_BASE) / perMandate);
}

/** The largest batch the gas ceiling can carry at the default allowance. */
export const MAX_BATCH_LIMIT = maxBatchFor(GAS_PER_MANDATE);

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

/** `IMandateHub.Status`, in declaration order. */
export type MandateStatus = "Active" | "Delinquent" | "Cancelled";

/** One mandate as the page read returns it: `getMandate`, `isChargeable` and `quoteCharge`. */
export interface MandateState {
  readonly id: bigint;
  /** The zero address for an id that was never created. */
  readonly payer: string;
  readonly status: MandateStatus;
  /** Seconds between charges, or zero for a stream. */
  readonly period: number;
  /** Periodic: the next boundary. Stream: the accrual checkpoint. */
  readonly nextChargeAt: bigint;
  readonly expiresAt: bigint;
  readonly amount: bigint;
  readonly maxPerCharge: bigint;
  readonly maxTotal: bigint;
  readonly totalCharged: bigint;
  /** Zero unless a stream is paused. */
  readonly pausedAt: bigint;
  readonly chargeable: boolean;
  /** Base units a charge would take now; zero when not chargeable. */
  readonly quote: bigint;
}

/** The head read: where every page is pinned and the clock every decision uses. */
export interface Head {
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
  /** Ids run from 1 to one below this. */
  readonly nextMandateId: bigint;
}

export interface DuePolicy {
  /** Base units a stream must have accrued before it is worth a charge. */
  readonly streamMinCharge: bigint;
  /** Seconds after its checkpoint a stream is charged whatever it has accrued. */
  readonly streamMaxAgeSeconds: bigint;
  /** Seconds between ticks. The near-expiry window is two of these. */
  readonly intervalSeconds: bigint;
}

export type ChargeReason = "periodic" | "min-charge" | "capped" | "max-age" | "near-expiry";
export type WaitReason = "not-due" | "paused" | "accruing";
/** States no mandate leaves: the id is read again every tick, but it can never be charged. */
export type FinishedReason = "unknown" | "cancelled" | "expired" | "completed";

export type Verdict =
  | { readonly action: "charge"; readonly reason: ChargeReason }
  | { readonly action: "wait"; readonly reason: WaitReason }
  | { readonly action: "finished"; readonly reason: FinishedReason };

/*//////////////////////////////////////////////////////////////
                           DUE SELECTION
//////////////////////////////////////////////////////////////*/

const ZERO_ADDRESS = /^0x0{40}$/i;

const isStream = (m: MandateState): boolean => m.period === 0;

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** What to do with one mandate at chain time `now`. */
export function judge(m: MandateState, now: bigint, policy: DuePolicy): Verdict {
  if (ZERO_ADDRESS.test(m.payer)) return { action: "finished", reason: "unknown" };
  if (m.status === "Cancelled") return { action: "finished", reason: "cancelled" };
  if (now > m.expiresAt) return { action: "finished", reason: "expired" };
  const spent = isStream(m) ? m.totalCharged >= m.maxTotal : m.totalCharged + m.amount > m.maxTotal;
  if (spent) return { action: "finished", reason: "completed" };
  if (m.pausedAt !== 0n) return { action: "wait", reason: "paused" };
  if (!m.chargeable || m.quote === 0n) return { action: "wait", reason: "not-due" };

  if (!isStream(m)) return { action: "charge", reason: "periodic" };

  if (m.quote >= policy.streamMinCharge) return { action: "charge", reason: "min-charge" };
  if (m.quote >= min(m.maxPerCharge, m.maxTotal - m.totalCharged)) return { action: "charge", reason: "capped" };
  if (now - m.nextChargeAt >= policy.streamMaxAgeSeconds) return { action: "charge", reason: "max-age" };
  if (m.expiresAt - now <= 2n * policy.intervalSeconds) return { action: "charge", reason: "near-expiry" };
  return { action: "wait", reason: "accruing" };
}

export interface DueMandate {
  readonly id: bigint;
  readonly reason: ChargeReason;
  readonly pastDue: boolean;
  readonly quote: bigint;
}

export interface Selection {
  /** What goes in the report: healthy mandates first, then past-due ones, each oldest first. */
  readonly batch: readonly DueMandate[];
  /** Due, but beyond the batch cap. They lead the next tick. */
  readonly deferred: readonly DueMandate[];
  readonly waiting: Readonly<Record<WaitReason, number>>;
  readonly finished: Readonly<Record<FinishedReason, number>>;
}

/** Judge every mandate, order the due ones, and cap the batch at `maxBatch`. */
export function selectDue(mandates: readonly MandateState[], now: bigint, policy: DuePolicy, maxBatch: number): Selection {
  const due: DueMandate[] = [];
  const waiting: Record<WaitReason, number> = { "not-due": 0, paused: 0, accruing: 0 };
  const finished: Record<FinishedReason, number> = { unknown: 0, cancelled: 0, expired: 0, completed: 0 };

  for (const m of mandates) {
    const verdict = judge(m, now, policy);
    if (verdict.action === "charge") {
      due.push({ id: m.id, reason: verdict.reason, pastDue: m.status === "Delinquent", quote: m.quote });
    } else if (verdict.action === "wait") {
      waiting[verdict.reason] += 1;
    } else {
      finished[verdict.reason] += 1;
    }
  }

  due.sort((a, b) => {
    if (a.pastDue !== b.pastDue) return a.pastDue ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { batch: due.slice(0, maxBatch), deferred: due.slice(maxBatch), waiting, finished };
}

/*//////////////////////////////////////////////////////////////
                              PAGING
//////////////////////////////////////////////////////////////*/

export interface PagePlan {
  /** The ids to read, one array per chain read. */
  readonly pages: readonly (readonly bigint[])[];
  /** Pages the hub holds in all. More than `pages.length` means this tick reads a slice. */
  readonly totalPages: number;
}

/**
 * The ids to read this tick, in pages of `pageSize`.
 *
 * Every id from 1 to `nextMandateId - 1` is read while the hub fits in `maxPages` pages. Past
 * that, the tick reads `maxPages` consecutive pages starting at `tickIndex * maxPages`, wrapping,
 * so successive ticks cover the whole hub. `tickIndex` comes from the chain clock, which every
 * node agrees on, so the slice is deterministic.
 */
export function planPages(nextMandateId: bigint, pageSize: number, maxPages: number, tickIndex: bigint): PagePlan {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError(`maxPages must be a positive integer, got ${maxPages}`);

  const count = nextMandateId > 1n ? nextMandateId - 1n : 0n;
  const size = BigInt(pageSize);
  const totalPages = Number((count + size - 1n) / size);
  const pageAt = (index: number): bigint[] => {
    const first = 1n + BigInt(index) * size;
    const last = min(first + size - 1n, count);
    const ids: bigint[] = [];
    for (let id = first; id <= last; id += 1n) ids.push(id);
    return ids;
  };

  if (totalPages <= maxPages) {
    return { pages: Array.from({ length: totalPages }, (_, index) => pageAt(index)), totalPages };
  }
  const start = Number((tickIndex * BigInt(maxPages)) % BigInt(totalPages));
  return { pages: Array.from({ length: maxPages }, (_, offset) => pageAt((start + offset) % totalPages)), totalPages };
}

/*//////////////////////////////////////////////////////////////
                                GAS
//////////////////////////////////////////////////////////////*/

/** The gas limit for a report charging `mandates` ids at `perMandate` gas each. */
export function gasLimitFor(mandates: number, perMandate: bigint = GAS_PER_MANDATE): bigint {
  if (!Number.isSafeInteger(mandates) || mandates < 1) throw new RangeError(`a report charges at least one mandate, got ${mandates}`);
  const limit = GAS_BASE + perMandate * BigInt(mandates);
  return limit < GAS_CEILING ? limit : GAS_CEILING;
}

/*//////////////////////////////////////////////////////////////
                               TICK
//////////////////////////////////////////////////////////////*/

export interface TickConfig {
  readonly hub: string;
  readonly charger: string;
  readonly pageSize: number;
  readonly maxBatch: number;
  /** Gas allowed per mandate in a report: the most expensive charge path on this network. */
  readonly gasPerMandate: bigint;
  readonly policy: DuePolicy;
}

/** The little of the SDK's `Runtime` a tick uses. */
export interface TickRuntime {
  log(message: string): void;
}

export type TxStatus = "success" | "reverted" | "fatal";

export interface WriteOutcome {
  readonly txStatus: TxStatus;
  /** Whether `onReport` itself succeeded, when the forwarder says. */
  readonly receiverStatus?: "success" | "reverted";
  readonly txHash?: string;
  /** Wei. */
  readonly fee?: bigint;
  readonly error?: string;
}

/** The chain as the tick sees it. Each port throws when its capability call fails. */
export interface TickPorts {
  /** Block number, timestamp and `nextMandateId`, at a finalized block. */
  readHead(): Head;
  /** One page of mandates, pinned to the head's block. */
  readPage(ids: readonly bigint[], blockNumber: bigint): MandateState[];
  /** Sign `abi.encode(uint256[] ids)` as a report and write it to the charger. */
  writeReport(ids: readonly bigint[], gasLimit: bigint): WriteOutcome;
}

/** What an execution returns. Strings rather than bigints, so it serialises as it is. */
export interface TickSummary {
  readonly blockNumber: string;
  readonly timestamp: string;
  readonly mandates: number;
  readonly read: number;
  readonly due: number;
  readonly deferred: number;
  readonly reported: readonly string[];
  readonly gasLimit?: string;
  readonly txHash?: string;
}

/** A tick that could not finish. The message is the whole of what an operator sees. */
export class TickFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TickFailure";
  }
}

const describeCounts = (counts: Readonly<Record<string, number>>): string =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ") || "none";

/** Read, decide, and write one report if anything is due. Throws `TickFailure` when the write did not land. */
export function runTick(runtime: TickRuntime, config: TickConfig, ports: TickPorts): TickSummary {
  const head = ports.readHead();
  const mandates = head.nextMandateId > 1n ? Number(head.nextMandateId - 1n) : 0;
  runtime.log(`weir charger: hub ${config.hub} at finalized block ${head.blockNumber} (time ${head.timestamp}): ${mandates} mandate(s)`);

  const plan = planPages(head.nextMandateId, config.pageSize, MAX_PAGES_PER_TICK, head.timestamp / config.policy.intervalSeconds);
  if (plan.pages.length < plan.totalPages) {
    runtime.log(`weir charger: reading ${plan.pages.length} of ${plan.totalPages} pages this tick; later ticks read the rest`);
  }
  const states = plan.pages.flatMap((ids) => ports.readPage(ids, head.blockNumber));

  const selection = selectDue(states, head.timestamp, config.policy, config.maxBatch);
  const due = selection.batch.length + selection.deferred.length;
  runtime.log(
    `weir charger: read ${states.length}; due ${due}; waiting: ${describeCounts(selection.waiting)}; finished: ${describeCounts(selection.finished)}`,
  );

  const summary: TickSummary = {
    blockNumber: head.blockNumber.toString(),
    timestamp: head.timestamp.toString(),
    mandates,
    read: states.length,
    due,
    deferred: selection.deferred.length,
    reported: selection.batch.map((entry) => entry.id.toString()),
  };
  if (selection.batch.length === 0) {
    runtime.log("weir charger: nothing due; no report written");
    return summary;
  }

  for (const entry of selection.batch) {
    runtime.log(`weir charger: mandate ${entry.id} due (${entry.reason}${entry.pastDue ? ", past due" : ""}), quote ${entry.quote}`);
  }
  if (selection.deferred.length > 0) {
    runtime.log(`weir charger: ${selection.deferred.length} more due beyond the batch of ${config.maxBatch}; they lead the next tick`);
  }

  const ids = selection.batch.map((entry) => entry.id);
  const gasLimit = gasLimitFor(ids.length, config.gasPerMandate);
  runtime.log(`weir charger: writing a report for [${ids.join(", ")}] to ${config.charger} with a gas limit of ${gasLimit}`);
  const outcome = ports.writeReport(ids, gasLimit);

  const fee = outcome.fee === undefined ? "" : `, fee ${outcome.fee} wei`;
  const receiver = outcome.receiverStatus === undefined ? "" : `, onReport ${outcome.receiverStatus}`;
  runtime.log(`weir charger: report transaction ${outcome.txHash ?? "(no hash)"}: ${outcome.txStatus}${receiver}${fee}`);
  if (outcome.txStatus !== "success" || outcome.receiverStatus === "reverted") {
    throw new TickFailure(
      `the report for [${ids.join(", ")}] did not land: transaction ${outcome.txStatus}${receiver}` +
        `${outcome.error === undefined || outcome.error === "" ? "" : `: ${outcome.error}`}`,
    );
  }

  return {
    ...summary,
    gasLimit: gasLimit.toString(),
    ...(outcome.txHash === undefined ? {} : { txHash: outcome.txHash }),
  };
}
