/**
 * The mandate model the handlers apply, as pure functions over plain values.
 *
 * Standing, MRR and the payer's monthly commitment follow the rules the Weir API uses, so the two
 * indexes agree figure for figure: `standingOf` is `standingOf` in `packages/shared/src/types.ts`,
 * `mrrOf` is `monthlyAmount` in `apps/api/src/domain/stats.ts`, and `commitmentOf` is what the
 * payments page adds up as "Committed each month". They are restated here because the hosted
 * service builds this directory on its own; `test/model.test.ts` holds the copies to the
 * originals.
 */

/** What the handlers need to know about one network, from the deployment record. */
export interface NetworkInfo {
  readonly name: string;
  readonly startBlock: number;
  readonly hub: string;
  readonly charger: string;
  /** The CRE `KeystoneForwarder`, or empty where CRE has none. */
  readonly forwarder: string;
  /** The CRE simulator's `MockKeystoneForwarder`, or empty. */
  readonly simulationForwarder: string;
  /** The `MandateMeter`, or empty where the network has none. */
  readonly meter: string;
  /** The block the meter was deployed at, or 0 where there is none. */
  readonly meterStartBlock: number;
  /** Asset symbol by lowercase address. */
  readonly assets: Readonly<Record<string, string>>;
  /** A keyless RPC, read only for block times; `ENVIO_RPC_URL_<chainId>` overrides it. */
  readonly rpcUrl: string;
}

/** `IMandateHub.Status` and `IMandateMeter.Status`, in enum order: the same three values. */
export type Status = "Active" | "Delinquent" | "Cancelled";

export const STATUSES: readonly Status[] = ["Active", "Delinquent", "Cancelled"];

/**
 * The state a person reads. The API spells `PastDue` "Past due"; a GraphQL enum value cannot hold
 * a space.
 */
export type Standing = "Active" | "Paused" | "PastDue" | "Cancelled" | "Expired" | "Completed";

/** `ChargeFailed.reason`, the `REASON_*` codes in `IMandateHub.sol`. */
export type FailureReason = "InsufficientBalance" | "InsufficientAllowance" | "TransferRefused" | "Unknown";

/**
 * Who sent a charge. `Cre` is a Chainlink CRE report through `MandateCharger.onReport`, `Keeper` a
 * batch through `MandateCharger.chargeMany`, `Direct` a call to `MandateHub.charge` itself, and
 * `Settlement` what a stream had accrued, collected as it was paused or cancelled.
 */
export type Trigger = "Cre" | "Keeper" | "Direct" | "Settlement";

/** Thirty days, the month MRR is quoted over, as in the API. */
export const MONTH_SECONDS = 2_592_000n;

/** Seconds in a day, for the daily series. */
export const DAY_SECONDS = 86_400n;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The fields of a mandate its standing and figures depend on. */
export interface MandateFigures {
  readonly status: Status;
  readonly pausedAt: bigint;
  readonly expiresAt: bigint;
  readonly totalCharged: bigint;
  readonly maxTotal: bigint;
  readonly amount: bigint;
  readonly period: number;
}

/**
 * The contract never transitions a mandate at expiry or at its cap, so `Expired` and `Completed`
 * exist only here, and `Expired` depends on the time it is asked at.
 */
export function standingOf(mandate: MandateFigures, now: bigint): Standing {
  if (mandate.status === "Cancelled") return "Cancelled";
  if (now > mandate.expiresAt) return "Expired";
  const spent =
    mandate.period === 0
      ? mandate.totalCharged >= mandate.maxTotal
      : mandate.totalCharged + mandate.amount > mandate.maxTotal;
  if (spent) return "Completed";
  if (mandate.pausedAt !== 0n) return "Paused";
  if (mandate.status === "Delinquent") return "PastDue";
  return "Active";
}

/** A standing no later event or moment can change: the mandate is over for good. */
export function isFinal(standing: Standing): boolean {
  return standing === "Cancelled" || standing === "Expired";
}

/** Running, stopped for now, or behind on payment: what a payer still has in force. */
export function isLive(standing: Standing): boolean {
  return standing === "Active" || standing === "Paused" || standing === "PastDue";
}

/** A periodic mandate's amount scaled to thirty days, rounded down. Zero for a stream. */
export function monthly(mandate: Pick<MandateFigures, "amount" | "period">): bigint {
  return mandate.period === 0 ? 0n : (mandate.amount * MONTH_SECONDS) / BigInt(mandate.period);
}

/** One mandate's MRR for its merchant: an `Active` periodic mandate's monthly amount. */
export function mrrOf(mandate: Pick<MandateFigures, "amount" | "period">, standing: Standing): bigint {
  return standing === "Active" ? monthly(mandate) : 0n;
}

/** What a payer has committed each month: periodic mandates still running or behind. */
export function commitmentOf(mandate: Pick<MandateFigures, "amount" | "period">, standing: Standing): bigint {
  return standing === "Active" || standing === "PastDue" ? monthly(mandate) : 0n;
}

/**
 * The accrual checkpoint after a stream resumes, as `MandateHub._resume` moves it: forward by the
 * part of the pause that was billable, so paused time is never billed.
 */
export function resumedCheckpoint(nextChargeAt: bigint, pausedAt: bigint, now: bigint): bigint {
  const billableFrom = pausedAt > nextChargeAt ? pausedAt : nextChargeAt;
  return now > billableFrom ? nextChargeAt + (now - billableFrom) : nextChargeAt;
}

export function failureReason(code: number): FailureReason {
  switch (code) {
    case 1:
      return "InsufficientBalance";
    case 2:
      return "InsufficientAllowance";
    case 3:
      return "TransferRefused";
    default:
      return "Unknown";
  }
}

/**
 * Who sent a charge, as far as the transaction alone says: its target. A CRE report is also
 * recognised by `ReportCharged` later in the same transaction, and a settlement by the pause or
 * cancel that follows it, which is where those two are confirmed.
 */
export function triggerOf(to: string | undefined, network: NetworkInfo): Trigger {
  const target = to?.toLowerCase();
  if (target === undefined || target === "") return "Direct";
  if (target === network.forwarder || target === network.simulationForwarder) return "Cre";
  if (target === network.charger) return "Keeper";
  return "Direct";
}

/** The UTC day a moment falls in. */
export function dayOf(seconds: bigint): { date: string; dayStart: bigint } {
  const dayStart = seconds - (((seconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS);
  return { date: new Date(Number(dayStart) * 1000).toISOString().slice(0, 10), dayStart };
}

/** The count fields every aggregate keeps, one per standing plus the live total. */
export interface StandingCounts {
  readonly activeMandates: number;
  readonly pausedMandates: number;
  readonly pastDueMandates: number;
  readonly completedMandates: number;
  readonly expiredMandates: number;
  readonly cancelledMandates: number;
  readonly liveMandates: number;
}

export const NO_MANDATES: StandingCounts = {
  activeMandates: 0,
  pausedMandates: 0,
  pastDueMandates: 0,
  completedMandates: 0,
  expiredMandates: 0,
  cancelledMandates: 0,
  liveMandates: 0,
};

const COUNT_FIELD: Record<Standing, Exclude<keyof StandingCounts, "liveMandates">> = {
  Active: "activeMandates",
  Paused: "pausedMandates",
  PastDue: "pastDueMandates",
  Completed: "completedMandates",
  Expired: "expiredMandates",
  Cancelled: "cancelledMandates",
};

/** `counts` with one mandate moved from `from` (none for a new one) to `to`. */
export function moveCount<T extends StandingCounts>(counts: T, from: Standing | undefined, to: Standing): T {
  if (from === to) return counts;
  const next: Record<keyof StandingCounts, number> = {
    activeMandates: counts.activeMandates,
    pausedMandates: counts.pausedMandates,
    pastDueMandates: counts.pastDueMandates,
    completedMandates: counts.completedMandates,
    expiredMandates: counts.expiredMandates,
    cancelledMandates: counts.cancelledMandates,
    liveMandates: counts.liveMandates,
  };
  if (from !== undefined) {
    next[COUNT_FIELD[from]] -= 1;
    if (isLive(from)) next.liveMandates -= 1;
  }
  next[COUNT_FIELD[to]] += 1;
  if (isLive(to)) next.liveMandates += 1;
  return { ...counts, ...next };
}

/*
 * Metered mandates: `MandateMeter`. A meter is paid by usage receipts rather than on a schedule,
 * so it has no MRR or commitment, and no pause. Its standing follows the same order as a
 * mandate's, as far as a meter can take it: cancelled, then expired, then completed (the lifetime
 * cap is spent), then past due (the last settlement could not be funded), then active.
 */

/** What a person reads about a meter. */
export type MeterStanding = "Active" | "PastDue" | "Completed" | "Expired" | "Cancelled";

/** The fields of a meter its standing depends on. */
export interface MeterFigures {
  readonly status: Status;
  readonly expiresAt: bigint;
  readonly totalCharged: bigint;
  readonly maxTotal: bigint;
}

/**
 * Receipts issued up to `expiresAt` are honored, so a meter is expired from the second after it,
 * as a mandate is. Neither expiry nor cancellation stops a receipt issued before it from settling.
 */
export function meterStandingOf(meter: MeterFigures, now: bigint): MeterStanding {
  if (meter.status === "Cancelled") return "Cancelled";
  if (now > meter.expiresAt) return "Expired";
  if (meter.totalCharged >= meter.maxTotal) return "Completed";
  if (meter.status === "Delinquent") return "PastDue";
  return "Active";
}

/** A meter that takes no new usage, whatever later settles on it. */
export function isMeterEnded(standing: MeterStanding): boolean {
  return standing === "Cancelled" || standing === "Expired";
}

/** Still taking usage: active, or behind on payment. */
export function isMeterLive(standing: MeterStanding): boolean {
  return standing === "Active" || standing === "PastDue";
}

/**
 * The period a settlement at `now` books into, as `MandateMeter._roll` moves it: when the current
 * one has run out, the latest boundary at or before `now`, aligned to the first period, with
 * nothing charged in it yet. A failed settlement rolls the period too; one with nothing to settle
 * reverts and leaves no event.
 */
export function rolledPeriod(periodStart: bigint, periodCharged: bigint, period: number, now: bigint): { periodStart: bigint; periodCharged: bigint } {
  const length = BigInt(period);
  if (now < periodStart + length) return { periodStart, periodCharged };
  return { periodStart: now - ((now - periodStart) % length), periodCharged: 0n };
}

/** The meter count fields every aggregate keeps, one per standing plus the live total. */
export interface MeterCounts {
  readonly activeMeters: number;
  readonly pastDueMeters: number;
  readonly completedMeters: number;
  readonly expiredMeters: number;
  readonly cancelledMeters: number;
  readonly liveMeters: number;
}

export const NO_METERS: MeterCounts = {
  activeMeters: 0,
  pastDueMeters: 0,
  completedMeters: 0,
  expiredMeters: 0,
  cancelledMeters: 0,
  liveMeters: 0,
};

const METER_COUNT_FIELD: Record<MeterStanding, Exclude<keyof MeterCounts, "liveMeters">> = {
  Active: "activeMeters",
  PastDue: "pastDueMeters",
  Completed: "completedMeters",
  Expired: "expiredMeters",
  Cancelled: "cancelledMeters",
};

/** `counts` with one meter moved from `from` (none for a new one) to `to`. */
export function moveMeterCount<T extends MeterCounts>(counts: T, from: MeterStanding | undefined, to: MeterStanding): T {
  if (from === to) return counts;
  const next: Record<keyof MeterCounts, number> = {
    activeMeters: counts.activeMeters,
    pastDueMeters: counts.pastDueMeters,
    completedMeters: counts.completedMeters,
    expiredMeters: counts.expiredMeters,
    cancelledMeters: counts.cancelledMeters,
    liveMeters: counts.liveMeters,
  };
  if (from !== undefined) {
    next[METER_COUNT_FIELD[from]] -= 1;
    if (isMeterLive(from)) next.liveMeters -= 1;
  }
  next[METER_COUNT_FIELD[to]] += 1;
  if (isMeterLive(to)) next.liveMeters += 1;
  return { ...counts, ...next };
}
