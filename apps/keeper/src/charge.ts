/**
 * Step three: send due ids through `MandateCharger.chargeMany`, one batch at a time, and read
 * each mandate's outcome off the receipt.
 *
 * One signer and one transaction in flight: each receipt is awaited before the next batch is
 * built, because the nonce is read per send and two unawaited sends would share one. Every
 * batch is estimated and sent with a tight limit, since Monad bills the limit and not the gas
 * used (see {@link gasLimitFor}).
 *
 * The receipt says what happened to each id: the hub's `Charged` (money moved), the hub's
 * `ChargeFailed` (the payer could not fund it; nothing reverted and the mandate is past due and
 * retried), or the charger's `ChargeReverted` with the revert's selector. A revert is terminal,
 * and the id is dropped for good, only when its cause can never stop being true; anything else,
 * including a selector this build does not know, is retried.
 *
 * A failure to estimate, send or receive stops the run: the chain or the key is not answering,
 * and nothing about any mandate is learned from that.
 */

import {
  getAbiItem,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  stringToHex,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { VAULT_ACCRUAL_GAS, mandateChargerAbi, mandateHubAbi } from "@weir/shared";
import type { GasPolicy } from "./config.js";
import { describeError } from "./log.js";

/*//////////////////////////////////////////////////////////////
                         REVERT CLASSIFICATION
//////////////////////////////////////////////////////////////*/

/** Reverts whose cause can never stop being true. The id is dropped. */
export const TERMINAL_ERRORS = ["UnknownMandate", "MandateIsCancelled", "MandateExpired", "TotalCapExceeded"] as const;

/** Reverts that can stop being true. The id is kept and retried. */
export const RETRYABLE_ERRORS = ["NotDue", "MandateIsPaused", "PaymentMismatch"] as const;

export type Disposition = "terminal" | "retryable";

const selectorOf = (signature: string): Hex => keccak256(stringToHex(signature)).slice(0, 10) as Hex;

/** Every error the hub declares, plus Solidity's two built-ins, by selector. */
const ERROR_NAMES: ReadonlyMap<Hex, string> = new Map<Hex, string>([
  ...mandateHubAbi.flatMap((item) =>
    item.type === "error"
      ? [[selectorOf(`${item.name}(${item.inputs.map((input) => input.type).join(",")})`), item.name] as [Hex, string]]
      : [],
  ),
  ["0x08c379a0", "Error"],
  ["0x4e487b71", "Panic"],
]);

/** The error a selector names, or `undefined` for one this build does not know (or none at all). */
export function errorName(selector: Hex): string | undefined {
  return ERROR_NAMES.get(selector.toLowerCase() as Hex);
}

/** Terminal only for a known, permanent cause. An unknown revert is never grounds to drop an id. */
export function classifyRevert(name: string | undefined): Disposition {
  return name !== undefined && (TERMINAL_ERRORS as readonly string[]).includes(name) ? "terminal" : "retryable";
}

/*//////////////////////////////////////////////////////////////
                                GAS
//////////////////////////////////////////////////////////////*/

/** A batch's estimate is above the ceiling, so no limit can carry it. The batch is split. */
export class GasCeilingError extends Error {
  constructor(
    readonly estimate: bigint,
    readonly ceiling: bigint,
  ) {
    super(`the estimate of ${estimate} gas is above the ceiling of ${ceiling}`);
    this.name = "GasCeilingError";
  }
}

/**
 * The limit for an estimate: the estimate plus `marginBps` (rounded up) plus `marginGas`, no
 * lower than the floor and no higher than the ceiling.
 *
 * @throws {GasCeilingError} when the estimate alone is above the ceiling.
 */
export function gasLimitFor(estimate: bigint, policy: GasPolicy): bigint {
  if (estimate > policy.ceiling) throw new GasCeilingError(estimate, policy.ceiling);
  const padded = (estimate * (10_000n + policy.marginBps) + 9_999n) / 10_000n + policy.marginGas;
  if (padded < policy.floor) return policy.floor;
  return padded > policy.ceiling ? policy.ceiling : padded;
}

/*//////////////////////////////////////////////////////////////
                              OUTCOMES
//////////////////////////////////////////////////////////////*/

/** `ChargeFailed.reason`, in words. */
export const CHARGE_FAILED_REASONS: Readonly<Record<number, string>> = {
  1: "the payer's balance is too low",
  2: "the payer's allowance is too low",
  3: "the transfer was refused",
};

export type ChargeOutcome =
  | { readonly id: bigint; readonly kind: "charged"; readonly amount: bigint; readonly nextChargeAt: bigint }
  | { readonly id: bigint; readonly kind: "failed"; readonly reason: number; readonly required: bigint }
  | {
      readonly id: bigint;
      readonly kind: "reverted";
      readonly selector: Hex;
      readonly error: string | undefined;
      readonly disposition: Disposition;
    }
  /** The transaction succeeded and said nothing about this id. Never expected; retried. */
  | { readonly id: bigint; readonly kind: "missing" };

const OUTCOME_EVENTS = [
  getAbiItem({ abi: mandateHubAbi, name: "Charged" }),
  getAbiItem({ abi: mandateHubAbi, name: "ChargeFailed" }),
  getAbiItem({ abi: mandateChargerAbi, name: "ChargeReverted" }),
] as const;

export interface ChargeContracts {
  readonly hub: Address;
  readonly charger: Address;
}

/**
 * One outcome per id, in the order given, from a successful `chargeMany` receipt. Hub events
 * count only from the hub and `ChargeReverted` only from the charger, so a token or vault log
 * that happens to share a topic can never be read as an outcome.
 */
export function parseOutcomes(ids: readonly bigint[], logs: readonly Log[], contracts: ChargeContracts): ChargeOutcome[] {
  const found = new Map<bigint, ChargeOutcome>();
  for (const log of parseEventLogs({ abi: OUTCOME_EVENTS, logs: [...logs], strict: true })) {
    const fromHub = isAddressEqual(log.address, contracts.hub);
    const fromCharger = isAddressEqual(log.address, contracts.charger);
    const id = log.args.mandateId;
    if (found.has(id)) continue;
    if (log.eventName === "Charged" && fromHub) {
      found.set(id, { id, kind: "charged", amount: log.args.amount, nextChargeAt: log.args.nextChargeAt });
    } else if (log.eventName === "ChargeFailed" && fromHub) {
      found.set(id, { id, kind: "failed", reason: log.args.reason, required: log.args.required });
    } else if (log.eventName === "ChargeReverted" && fromCharger) {
      const error = errorName(log.args.reason);
      found.set(id, { id, kind: "reverted", selector: log.args.reason, error, disposition: classifyRevert(error) });
    }
  }
  return ids.map((id) => found.get(id) ?? { id, kind: "missing" });
}

/*//////////////////////////////////////////////////////////////
                             TRANSPORT
//////////////////////////////////////////////////////////////*/

export interface ChargeReceipt {
  readonly status: "success" | "reverted";
  readonly logs: readonly Log[];
  readonly gasUsed: bigint;
  readonly blockNumber: bigint;
}

/** The three calls a charge run makes. Structural, so tests drive the run without a chain. */
export interface ChargeTransport {
  estimate(ids: readonly bigint[]): Promise<bigint>;
  send(ids: readonly bigint[], gas: bigint): Promise<Hex>;
  wait(hash: Hex): Promise<ChargeReceipt>;
}

export interface ChargeTransportOptions {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
  readonly charger: Address;
  readonly receiptTimeoutMs?: number;
}

export function createChargeTransport(options: ChargeTransportOptions): ChargeTransport {
  const { publicClient, walletClient, charger } = options;
  const account = walletClient.account;
  return {
    estimate: (ids) =>
      publicClient.estimateContractGas({
        address: charger,
        abi: mandateChargerAbi,
        functionName: "chargeMany",
        args: [ids],
        account,
      }),
    send: (ids, gas) =>
      walletClient.writeContract({
        address: charger,
        abi: mandateChargerAbi,
        functionName: "chargeMany",
        args: [ids],
        gas,
        account,
        chain: walletClient.chain,
      }),
    wait: async (hash) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: options.receiptTimeoutMs ?? 60_000 });
      return { status: receipt.status, logs: receipt.logs, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
    },
  };
}

/*//////////////////////////////////////////////////////////////
                                RUN
//////////////////////////////////////////////////////////////*/

export interface BatchRecord {
  readonly ids: readonly bigint[];
  readonly estimate: bigint;
  readonly gasLimit: bigint;
  readonly hash: Hex;
  readonly status: "success" | "reverted";
  /** On Monad this is the limit: receipts report the gas billed. */
  readonly gasUsed: bigint;
  readonly blockNumber: bigint;
}

export interface ChargeRun {
  readonly outcomes: ChargeOutcome[];
  readonly batches: BatchRecord[];
  /** False when a batch could not be sent or confirmed, or its transaction reverted. */
  complete: boolean;
  errors: string[];
}

export interface ChargeOptions {
  readonly transport: ChargeTransport;
  readonly batchSize: number;
  readonly gas: GasPolicy;
  readonly contracts: ChargeContracts;
  /** The savings vault each mandate draws from, if any; each batch allows for every vault's accrual. */
  readonly vaults?: ReadonlyMap<bigint, Address>;
}

/**
 * The gas a batch needs beyond its estimate: one interest accrual for each distinct savings vault
 * it draws on, since an estimate run in the second of a vault's last touch does not see it.
 */
export function accrualGasFor(ids: readonly bigint[], vaults: ReadonlyMap<bigint, Address> | undefined): bigint {
  if (vaults === undefined) return 0n;
  const distinct = new Set<string>();
  for (const id of ids) {
    const vault = vaults.get(id);
    if (vault !== undefined && vault !== zeroAddress) distinct.add(vault.toLowerCase());
  }
  return VAULT_ACCRUAL_GAS * BigInt(distinct.size);
}

/** Charge `ids` in batches, in order, one transaction at a time. */
export async function chargeDue(ids: readonly bigint[], options: ChargeOptions): Promise<ChargeRun> {
  const { transport, batchSize, gas, contracts, vaults } = options;
  const run: ChargeRun = { outcomes: [], batches: [], complete: true, errors: [] };
  const queue: bigint[][] = [];
  for (let start = 0; start < ids.length; start += batchSize) queue.push(ids.slice(start, start + batchSize));

  for (let batch = queue.shift(); batch !== undefined; batch = queue.shift()) {
    let estimate: bigint;
    let gasLimit: bigint;
    try {
      estimate = await transport.estimate(batch);
      gasLimit = gasLimitFor(estimate + accrualGasFor(batch, vaults), gas);
    } catch (error) {
      if (error instanceof GasCeilingError && batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        queue.unshift(batch.slice(0, half), batch.slice(half));
        continue;
      }
      run.complete = false;
      run.errors.push(`estimating chargeMany for ${batch.length} mandate(s) failed: ${describeError(error)}`);
      if (error instanceof GasCeilingError) continue;
      break;
    }

    let hash: Hex;
    let receipt: ChargeReceipt;
    try {
      hash = await transport.send(batch, gasLimit);
      receipt = await transport.wait(hash);
    } catch (error) {
      run.complete = false;
      run.errors.push(`sending chargeMany for ${batch.length} mandate(s) failed: ${describeError(error)}`);
      break;
    }

    run.batches.push({ ids: batch, estimate, gasLimit, hash, ...receipt });
    if (receipt.status !== "success") {
      run.complete = false;
      run.errors.push(`chargeMany ${hash} reverted with a limit of ${gasLimit} gas; its mandates are retried next pass`);
      continue;
    }
    run.outcomes.push(...parseOutcomes(batch, receipt.logs, contracts));
  }
  return run;
}

/*//////////////////////////////////////////////////////////////
                              RETRIES
//////////////////////////////////////////////////////////////*/

export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 3_600_000;

/**
 * When a mandate that failed may be tried again.
 *
 * A past-due mandate stays chargeable, and every attempt costs gas whether or not the payer
 * has topped up, so an id whose charge failed for funding, or reverted for a reason the filter
 * cannot see coming, waits a minute, then two, doubling to an hour, until it charges. Reverts
 * the filter already accounts for (`NotDue`, `MandateIsPaused`) do not wait: they come from a
 * race with another charger or a pause, and the next read sees it. Held in memory: a restart
 * tries every id once more.
 */
export class RetrySchedule {
  readonly #entries = new Map<bigint, { attempts: number; notBefore: number }>();
  readonly #now: () => number;
  readonly #baseMs: number;
  readonly #maxMs: number;

  constructor(now: () => number = Date.now, baseMs = RETRY_BASE_MS, maxMs = RETRY_MAX_MS) {
    this.#now = now;
    this.#baseMs = baseMs;
    this.#maxMs = maxMs;
  }

  /** True while `id` is waiting out a failure. */
  isWaiting(id: bigint): boolean {
    const entry = this.#entries.get(id);
    return entry !== undefined && this.#now() < entry.notBefore;
  }

  get size(): number {
    let waiting = 0;
    for (const id of this.#entries.keys()) if (this.isWaiting(id)) waiting += 1;
    return waiting;
  }

  /** Record an outcome. Returns the wait imposed, in milliseconds, or `undefined` for none. */
  record(outcome: ChargeOutcome): number | undefined {
    const backs =
      outcome.kind === "failed" ||
      outcome.kind === "missing" ||
      (outcome.kind === "reverted" &&
        outcome.disposition === "retryable" &&
        outcome.error !== "NotDue" &&
        outcome.error !== "MandateIsPaused");
    if (!backs) {
      this.#entries.delete(outcome.id);
      return undefined;
    }
    const attempts = (this.#entries.get(outcome.id)?.attempts ?? 0) + 1;
    const delay = Math.min(this.#baseMs * 2 ** Math.min(attempts - 1, 30), this.#maxMs);
    this.#entries.set(outcome.id, { attempts, notBefore: this.#now() + delay });
    return delay;
  }

  forget(id: bigint): void {
    this.#entries.delete(id);
  }
}
