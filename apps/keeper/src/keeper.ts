/**
 * One keeper pass, composed from the three steps: discover the working set, read it and select
 * what is due, charge it. Also answers the two questions the HTTP server asks between passes:
 * how the last pass went, and what is due right now.
 */

import type { Address, Hex, PublicClient } from "viem";
import { formatDollarsExact } from "@weir/shared";
import { chargeDue, CHARGE_FAILED_REASONS, RetrySchedule, type BatchRecord, type ChargeOutcome, type ChargeTransport } from "./charge.js";
import type { GasPolicy } from "./config.js";
import { discover, type DiscoverResult, type MandateCursor } from "./discover.js";
import { readMandates, selectDue, type ChargeReason, type DropReason, type DuePolicy } from "./filter.js";
import type { HistorySource } from "./history.js";
import { describeError, type Logger } from "./log.js";

export interface KeeperOptions {
  readonly chainId: number;
  readonly publicClient: PublicClient;
  readonly transport: ChargeTransport;
  readonly keeper: Address;
  readonly hub: Address;
  readonly charger: Address;
  readonly multicall: Address;
  readonly history: Pick<HistorySource, "readSegment">;
  readonly cursor: MandateCursor;
  readonly policy: DuePolicy;
  readonly batchSize: number;
  readonly gas: GasPolicy;
  /** The accepted assets by symbol, for log lines. */
  readonly assets: Readonly<Record<string, Address>>;
  readonly confirmations?: bigint;
  readonly retries?: RetrySchedule;
  /** A link for a transaction hash in log lines; the bare hash when absent. */
  readonly explorer?: (hash: Hex) => string;
  readonly log: Logger;
  readonly now?: () => Date;
}

export interface PassCounts {
  readonly workingSet: number;
  readonly due: number;
  readonly charged: number;
  readonly pastDue: number;
  readonly reverted: number;
  readonly dropped: number;
  /** Due, but waiting out an earlier failure. */
  readonly deferred: number;
}

export interface PassResult {
  /** False when the pass could not finish: a read failed, or a batch was not sent or confirmed. */
  readonly ok: boolean;
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly head: bigint | undefined;
  readonly discovered: DiscoverResult | undefined;
  readonly due: ReadonlyArray<{ readonly id: bigint; readonly reason: ChargeReason }>;
  readonly dropped: ReadonlyArray<{ readonly id: bigint; readonly reason: DropReason | string }>;
  readonly outcomes: readonly ChargeOutcome[];
  readonly batches: readonly BatchRecord[];
  readonly counts: PassCounts;
  readonly errors: readonly string[];
}

export interface DueNow {
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
  readonly ids: bigint[];
}

export interface KeeperHealth {
  readonly chainId: number;
  readonly keeper: Address;
  readonly startedAt: string;
  readonly lastPass: {
    readonly at: string;
    readonly ok: boolean;
    readonly durationMs: number;
    readonly head: string | null;
    readonly errors: readonly string[];
  } | null;
  readonly lastSuccessfulPassAt: string | null;
  readonly workingSet: number;
  readonly waitingForRetry: number;
  readonly lastOutcomes: PassCounts | null;
}

export class Keeper {
  readonly #options: KeeperOptions;
  readonly #retries: RetrySchedule;
  readonly #now: () => Date;
  readonly #symbols: ReadonlyMap<string, string>;
  readonly #startedAt: Date;
  #lastPass: PassResult | undefined;
  #lastSuccess: Date | undefined;
  #running: Promise<PassResult> | undefined;

  constructor(options: KeeperOptions) {
    this.#options = options;
    this.#retries = options.retries ?? new RetrySchedule();
    this.#now = options.now ?? (() => new Date());
    this.#symbols = new Map(Object.entries(options.assets).map(([symbol, address]) => [address.toLowerCase(), symbol]));
    this.#startedAt = this.#now();
  }

  get cursor(): MandateCursor {
    return this.#options.cursor;
  }

  get lastPass(): PassResult | undefined {
    return this.#lastPass;
  }

  /** One pass. Never throws; a pass that could not finish says so in `ok` and `errors`. Passes never overlap. */
  runPass(): Promise<PassResult> {
    this.#running ??= this.#pass().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** Resolves when the pass in progress, if any, has finished. */
  async idle(): Promise<void> {
    await this.#running;
  }

  /** The ids due at the head, read fresh and not charged: what `GET /due` serves. */
  async dueNow(): Promise<DueNow> {
    const { publicClient, hub, multicall, cursor, policy } = this.#options;
    const read = await readMandates(publicClient, { hub, multicall, ids: cursor.ids });
    const { due } = selectDue(read, policy);
    const ids = due.map((entry) => entry.read.id).filter((id) => !this.#retries.isWaiting(id));
    return { blockNumber: read.blockNumber, timestamp: read.timestamp, ids };
  }

  health(): KeeperHealth {
    const pass = this.#lastPass;
    return {
      chainId: this.#options.chainId,
      keeper: this.#options.keeper,
      startedAt: this.#startedAt.toISOString(),
      lastPass:
        pass === undefined
          ? null
          : {
              at: pass.startedAt.toISOString(),
              ok: pass.ok,
              durationMs: pass.durationMs,
              head: pass.head === undefined ? null : pass.head.toString(),
              errors: pass.errors,
            },
      lastSuccessfulPassAt: this.#lastSuccess?.toISOString() ?? null,
      workingSet: this.#options.cursor.size,
      waitingForRetry: this.#retries.size,
      lastOutcomes: pass?.counts ?? null,
    };
  }

  async #pass(): Promise<PassResult> {
    const { publicClient, cursor, history, hub, charger, multicall, policy, log } = this.#options;
    const startedAt = this.#now();
    const errors: string[] = [];
    let head: bigint | undefined;
    let discovered: DiscoverResult | undefined;
    const due: Array<{ id: bigint; reason: ChargeReason }> = [];
    const dropped: Array<{ id: bigint; reason: string }> = [];
    let outcomes: ChargeOutcome[] = [];
    let batches: BatchRecord[] = [];
    let deferred = 0;

    try {
      head = await publicClient.getBlockNumber({ cacheTime: 0 });
      discovered = await discover({
        cursor,
        history,
        head,
        log,
        ...(this.#options.confirmations === undefined ? {} : { confirmations: this.#options.confirmations }),
      });
      if (discovered.added.length > 20) log.info(`${discovered.added.length} mandates discovered`);
      else for (const id of discovered.added) log.info(`mandate ${id} discovered`);
      for (const id of discovered.cancelled) {
        this.#retries.forget(id);
        dropped.push({ id, reason: "cancelled" });
        log.info(`mandate ${id} cancelled; dropped`);
      }

      const read = await readMandates(publicClient, { hub, multicall, ids: cursor.ids });
      const selection = selectDue(read, policy);

      if (selection.dropped.length > 0) {
        await cursor.drop(selection.dropped.map((entry) => entry.id));
        for (const entry of selection.dropped) {
          this.#retries.forget(entry.id);
          dropped.push(entry);
          log.info(`mandate ${entry.id} dropped: ${entry.reason}`);
        }
      }

      const reasons = new Map<bigint, ChargeReason>();
      const toCharge: bigint[] = [];
      for (const entry of selection.due) {
        due.push({ id: entry.read.id, reason: entry.reason });
        if (this.#retries.isWaiting(entry.read.id)) {
          deferred += 1;
          continue;
        }
        reasons.set(entry.read.id, entry.reason);
        toCharge.push(entry.read.id);
      }
      const assetOf = new Map(read.mandates.map((entry) => [entry.id, entry.mandate.asset]));
      const vaultOf = new Map(read.mandates.map((entry) => [entry.id, entry.mandate.vault]));

      if (toCharge.length > 0) {
        const run = await chargeDue(toCharge, {
          transport: this.#options.transport,
          batchSize: this.#options.batchSize,
          gas: this.#options.gas,
          contracts: { hub, charger },
          vaults: vaultOf,
        });
        outcomes = run.outcomes;
        batches = run.batches;
        errors.push(...run.errors);

        const link = this.#options.explorer ?? ((hash: Hex) => hash);
        for (const batch of run.batches) {
          log.info(
            `chargeMany [${batch.ids.join(", ")}] ${batch.status === "success" ? "landed" : "reverted"} in block ` +
              `${batch.blockNumber}, gas limit ${gas(batch.gasLimit)} from an estimate of ${gas(batch.estimate)}: ${link(batch.hash)}`,
          );
        }

        const terminal: bigint[] = [];
        for (const outcome of outcomes) {
          const wait = this.#retries.record(outcome);
          const symbol = this.#symbol(assetOf.get(outcome.id));
          log.info(this.#describe(outcome, reasons.get(outcome.id), symbol, wait));
          if (outcome.kind === "reverted" && outcome.disposition === "terminal") terminal.push(outcome.id);
        }
        if (terminal.length > 0) {
          await cursor.drop(terminal);
          for (const id of terminal) {
            this.#retries.forget(id);
            const outcome = outcomes.find((entry) => entry.id === id);
            dropped.push({ id, reason: outcome?.kind === "reverted" ? (outcome.error ?? "reverted") : "reverted" });
          }
        }
      }
    } catch (error) {
      errors.push(describeError(error));
    }

    for (const error of errors) log.error(error);
    const counts: PassCounts = {
      workingSet: cursor.size,
      due: due.length,
      charged: outcomes.filter((outcome) => outcome.kind === "charged").length,
      pastDue: outcomes.filter((outcome) => outcome.kind === "failed").length,
      reverted: outcomes.filter((outcome) => outcome.kind === "reverted" || outcome.kind === "missing").length,
      dropped: dropped.length,
      deferred,
    };
    const result: PassResult = {
      ok: errors.length === 0,
      startedAt,
      durationMs: this.#now().getTime() - startedAt.getTime(),
      head,
      discovered,
      due,
      dropped,
      outcomes,
      batches,
      counts,
      errors,
    };
    this.#lastPass = result;
    if (result.ok) this.#lastSuccess = startedAt;
    return result;
  }

  #symbol(asset: Address | undefined): string {
    return asset === undefined ? "" : (this.#symbols.get(asset.toLowerCase()) ?? asset);
  }

  #describe(outcome: ChargeOutcome, reason: ChargeReason | undefined, symbol: string, waitMs: number | undefined): string {
    const retry = waitMs === undefined ? "" : `; next attempt in ${formatWait(waitMs)}`;
    switch (outcome.kind) {
      case "charged":
        return `mandate ${outcome.id} charged ${formatDollarsExact(outcome.amount)} ${symbol} (${reason ?? "due"})`;
      case "failed":
        return (
          `mandate ${outcome.id} past due: ${CHARGE_FAILED_REASONS[outcome.reason] ?? `reason ${outcome.reason}`} ` +
          `for ${formatDollarsExact(outcome.required)} ${symbol}${retry}`
        );
      case "reverted": {
        const name = outcome.error ?? (outcome.selector === "0x00000000" ? "without a reason" : `with selector ${outcome.selector}`);
        const fate = outcome.disposition === "terminal" ? "; dropped" : retry === "" ? "; retried next pass" : retry;
        return `mandate ${outcome.id} reverted ${name}${fate}`;
      }
      case "missing":
        return `mandate ${outcome.id} has no outcome in the receipt${retry}`;
    }
  }
}

/** A one-line summary of a pass. */
export function summarizePass(result: PassResult): string {
  const { counts } = result;
  const parts = [
    `${counts.workingSet} mandate(s) in the working set`,
    `${counts.due} due`,
    `${counts.charged} charged`,
    `${counts.pastDue} past due`,
    `${counts.reverted} reverted`,
    `${counts.dropped} dropped`,
  ];
  if (counts.deferred > 0) parts.push(`${counts.deferred} waiting to retry`);
  const at = result.head === undefined ? "" : ` at block ${result.head}`;
  return `pass ${result.ok ? "complete" : "incomplete"}${at}: ${parts.join(", ")} (${result.durationMs} ms)`;
}

function gas(units: bigint): string {
  return units.toLocaleString("en-US");
}

function formatWait(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}
