/**
 * The aggregates one mandate feeds, loaded together, changed in memory and written back together.
 *
 * Every figure on `Network`, `Merchant`, `MerchantAsset`, `Payer`, `PayerAsset` and
 * `MerchantCustomer` is kept incrementally: a handler opens the books for the mandate it touches,
 * restates the mandate, adds what the event moved, and closes them. `restate` is the one place a
 * standing changes, and it carries the change into every count, MRR and commitment at once, so
 * the aggregates can never disagree with the mandates they sum.
 *
 * Handlers that touch several mandates (the expiry sweep) open and close the books once per
 * mandate: a close writes to the in-memory store, and the next open reads from it.
 *
 * Meters keep books of their own on the same rows (`openMeterBooks`, `restateMeter`): their counts
 * and amounts sit beside the mandates' in fields of their own, so no mandate figure includes them.
 *
 * Every row is copied as it is opened. `get` hands back the store's own object, and a handler runs
 * twice (once to preload, once for real): a change made in place during the first run would still
 * be there in the second, and every figure would be counted twice.
 */

import type {
  DailyStat,
  EvmOnEventContext,
  Mandate,
  MandateEvent,
  Merchant,
  Meter,
  MerchantAsset,
  MerchantCustomer,
  MerchantDailyStat,
  Network,
  Payer,
  PayerAsset,
} from "envio";

import {
  NO_MANDATES,
  NO_METERS,
  commitmentOf,
  dayOf,
  isFinal,
  isLive,
  isMeterEnded,
  meterStandingOf,
  moveCount,
  moveMeterCount,
  mrrOf,
  standingOf,
  type MeterStanding,
  type NetworkInfo,
  type Standing,
} from "./model.js";
import { NETWORKS } from "./networks.js";

export type Context = EvmOnEventContext;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const ids = {
  network: (chainId: number) => `${chainId}`,
  mandate: (chainId: number, mandateId: bigint) => `${chainId}-${mandateId}`,
  meter: (chainId: number, meterId: bigint) => `${chainId}-${meterId}`,
  account: (chainId: number, address: string) => `${chainId}-${address}`,
  accountAsset: (chainId: number, address: string, asset: string) => `${chainId}-${address}-${asset}`,
  customer: (chainId: number, merchant: string, payer: string) => `${chainId}-${merchant}-${payer}`,
  log: (chainId: number, transactionHash: string, logIndex: number) => `${chainId}-${transactionHash}-${logIndex}`,
  day: (chainId: number, date: string) => `${chainId}-${date}`,
  merchantDay: (chainId: number, merchant: string, date: string) => `${chainId}-${merchant}-${date}`,
};

export function networkInfo(chainId: number): NetworkInfo {
  const info = NETWORKS[chainId];
  if (info === undefined) throw new Error(`Chain ${chainId} is not in the deployment record; run \`pnpm sync\``);
  return info;
}

export function assetSymbol(chainId: number, asset: string): string {
  return networkInfo(chainId).assets[asset.toLowerCase()] ?? asset;
}

/** Who a mandate's figures belong to. */
export interface Parties {
  chainId: number;
  merchant: string;
  payer: string;
  asset: string;
}

export interface Books {
  network: Mutable<Network>;
  merchant: Mutable<Merchant>;
  merchantAsset: Mutable<MerchantAsset>;
  payer: Mutable<Payer>;
  payerAsset: Mutable<PayerAsset>;
  customer: Mutable<MerchantCustomer>;
}

export function partiesOf(mandate: Pick<Mandate, "chainId" | "merchant_id" | "payer_id" | "asset">): Parties {
  const prefix = `${mandate.chainId}-`;
  return {
    chainId: mandate.chainId,
    merchant: mandate.merchant_id.slice(prefix.length),
    payer: mandate.payer_id.slice(prefix.length),
    asset: mandate.asset,
  };
}

/** A network with nothing indexed on it yet. */
export function newNetwork(chainId: number, now: bigint): Mutable<Network> {
  const info = networkInfo(chainId);
  return {
    id: ids.network(chainId),
    chainId,
    hub: info.hub,
    charger: info.charger,
    meter: info.meter,
    mandateCount: 0,
    ...NO_MANDATES,
    openMandates: 0,
    payerCount: 0,
    merchantCount: 0,
    chargeCount: 0,
    failureCount: 0,
    volume: 0n,
    mrr: 0n,
    reportCount: 0,
    standingAsOf: now,
    meterCount: 0,
    ...NO_METERS,
    openMeters: 0,
    meterPayerCount: 0,
    meterMerchantCount: 0,
    meterSettlementCount: 0,
    meterFailureCount: 0,
    meteredVolume: 0n,
  };
}

const NO_METER_FIGURES = { meterCount: 0, ...NO_METERS, meterSettlements: 0, meterFailures: 0 };

function newMerchant(chainId: number, merchant: string, now: bigint): Mutable<Merchant> {
  return {
    id: ids.account(chainId, merchant),
    chainId,
    address: merchant,
    mandateCount: 0,
    ...NO_MANDATES,
    mrr: 0n,
    revenue: 0n,
    chargeCount: 0,
    failureCount: 0,
    customers: 0,
    activeCustomers: 0,
    ...NO_METER_FIGURES,
    meteredRevenue: 0n,
    firstSeenAt: now,
  };
}

function newMerchantAsset(chainId: number, merchant: string, asset: string): Mutable<MerchantAsset> {
  return {
    id: ids.accountAsset(chainId, merchant, asset),
    chainId,
    merchant_id: ids.account(chainId, merchant),
    asset,
    assetSymbol: assetSymbol(chainId, asset),
    activeMandates: 0,
    pastDueMandates: 0,
    liveMandates: 0,
    mrr: 0n,
    revenue: 0n,
    chargeCount: 0,
    failureCount: 0,
    meteredRevenue: 0n,
    meterSettlements: 0,
  };
}

function newPayer(chainId: number, payer: string, now: bigint): Mutable<Payer> {
  return {
    id: ids.account(chainId, payer),
    chainId,
    address: payer,
    mandateCount: 0,
    ...NO_MANDATES,
    committedMonthly: 0n,
    totalPaid: 0n,
    chargeCount: 0,
    failureCount: 0,
    ...NO_METER_FIGURES,
    meteredPaid: 0n,
    firstSeenAt: now,
  };
}

/**
 * The books for one mandate's parties, created empty where this is their first mandate. A new
 * payer, merchant or customer is counted on its parent as it is created.
 */
export async function openBooks(context: Context, parties: Parties, now: bigint): Promise<Books> {
  const { chainId, merchant, payer, asset } = parties;
  const [network, merchantRow, merchantAsset, payerRow, payerAsset, customer] = await Promise.all([
    context.Network.get(ids.network(chainId)),
    context.Merchant.get(ids.account(chainId, merchant)),
    context.MerchantAsset.get(ids.accountAsset(chainId, merchant, asset)),
    context.Payer.get(ids.account(chainId, payer)),
    context.PayerAsset.get(ids.accountAsset(chainId, payer, asset)),
    context.MerchantCustomer.get(ids.customer(chainId, merchant, payer)),
  ]);
  const symbol = assetSymbol(chainId, asset);

  const books: Books = {
    network: network === undefined ? newNetwork(chainId, now) : { ...network },
    merchant: merchantRow !== undefined ? { ...merchantRow } : newMerchant(chainId, merchant, now),
    merchantAsset: merchantAsset !== undefined ? { ...merchantAsset } : newMerchantAsset(chainId, merchant, asset),
    payer: payerRow !== undefined ? { ...payerRow } : newPayer(chainId, payer, now),
    payerAsset: payerAsset !== undefined ? { ...payerAsset } : {
      id: ids.accountAsset(chainId, payer, asset),
      chainId,
      payer_id: ids.account(chainId, payer),
      asset,
      assetSymbol: symbol,
      liveMandates: 0,
      committedMonthly: 0n,
      totalPaid: 0n,
      chargeCount: 0,
      failureCount: 0,
    },
    customer: customer !== undefined ? { ...customer } : {
      id: ids.customer(chainId, merchant, payer),
      chainId,
      merchant_id: ids.account(chainId, merchant),
      payer_id: ids.account(chainId, payer),
      mandateCount: 0,
      liveMandates: 0,
      totalPaid: 0n,
      chargeCount: 0,
      firstMandateAt: now,
      lastChargedAt: undefined,
    },
  };
  // A party is counted at its first mandate, which is the only event that opens books for a party
  // with none: its row may already be there from a meter.
  if ((merchantRow?.mandateCount ?? 0) === 0) books.network.merchantCount += 1;
  if ((payerRow?.mandateCount ?? 0) === 0) books.network.payerCount += 1;
  if (customer === undefined) books.merchant.customers += 1;
  return books;
}

export function closeBooks(context: Context, books: Books): void {
  context.Network.set(books.network);
  context.Merchant.set(books.merchant);
  context.MerchantAsset.set(books.merchantAsset);
  context.Payer.set(books.payer);
  context.PayerAsset.set(books.payerAsset);
  context.MerchantCustomer.set(books.customer);
}

/**
 * `draft` with its standing and everything derived from it evaluated at `now`, and the change
 * from `before` (none for a new mandate) carried into every aggregate in `books`.
 */
export function restate(books: Books, before: Mandate | undefined, draft: Mandate, now: bigint): Mandate {
  const standing = standingOf(draft, now);
  const after: Mandate = {
    ...draft,
    standing,
    ended: isFinal(standing),
    standingAsOf: now,
    remaining: draft.maxTotal - draft.totalCharged,
    mrr: mrrOf(draft, standing),
    committedMonthly: commitmentOf(draft, standing),
  };

  const from: Standing | undefined = before?.standing;
  if (from !== standing) {
    books.network = moveCount(books.network, from, standing);
    books.merchant = moveCount(books.merchant, from, standing);
    books.payer = moveCount(books.payer, from, standing);

    const wasOpen = from !== undefined && !isFinal(from);
    books.network.openMandates += (isFinal(standing) ? 0 : 1) - (wasOpen ? 1 : 0);

    const live = (isLive(standing) ? 1 : 0) - (from !== undefined && isLive(from) ? 1 : 0);
    const active = (standing === "Active" ? 1 : 0) - (from === "Active" ? 1 : 0);
    const pastDue = (standing === "PastDue" ? 1 : 0) - (from === "PastDue" ? 1 : 0);
    books.merchantAsset.liveMandates += live;
    books.merchantAsset.activeMandates += active;
    books.merchantAsset.pastDueMandates += pastDue;
    books.payerAsset.liveMandates += live;

    const hadLive = books.customer.liveMandates > 0;
    books.customer.liveMandates += live;
    const hasLive = books.customer.liveMandates > 0;
    if (hadLive !== hasLive) books.merchant.activeCustomers += hasLive ? 1 : -1;
  }

  const mrr = after.mrr - (before?.mrr ?? 0n);
  books.network.mrr += mrr;
  books.merchant.mrr += mrr;
  books.merchantAsset.mrr += mrr;

  const committed = after.committedMonthly - (before?.committedMonthly ?? 0n);
  books.payer.committedMonthly += committed;
  books.payerAsset.committedMonthly += committed;

  if (now > books.network.standingAsOf) books.network.standingAsOf = now;
  return after;
}

const EMPTY_DAY = {
  volume: 0n,
  charges: 0,
  failures: 0,
  newMandates: 0,
  cancellations: 0,
  expirations: 0,
  activeMandates: 0,
  mrr: 0n,
  newMeters: 0,
  meteredVolume: 0n,
  meterSettlements: 0,
  meterFailures: 0,
};

/** The network's row for the UTC day `at` falls in. */
export async function openDay(context: Context, chainId: number, at: bigint): Promise<Mutable<DailyStat>> {
  const { date, dayStart } = dayOf(at);
  const day = await context.DailyStat.get(ids.day(chainId, date));
  return day !== undefined ? { ...day } : { id: ids.day(chainId, date), chainId, date, dayStart, ...EMPTY_DAY, reports: 0 };
}

/** A day's rows for the network and one merchant, and whether each is new. */
export interface Days {
  day: Mutable<DailyStat>;
  merchantDay: Mutable<MerchantDailyStat>;
  fresh: { day: boolean; merchantDay: boolean };
}

export async function openDays(context: Context, chainId: number, merchant: string, at: bigint): Promise<Days> {
  const { date, dayStart } = dayOf(at);
  const [day, merchantDay] = await Promise.all([
    context.DailyStat.get(ids.day(chainId, date)),
    context.MerchantDailyStat.get(ids.merchantDay(chainId, merchant, date)),
  ]);
  return {
    fresh: { day: day === undefined, merchantDay: merchantDay === undefined },
    day: day !== undefined ? { ...day } : { id: ids.day(chainId, date), chainId, date, dayStart, ...EMPTY_DAY, reports: 0 },
    merchantDay: merchantDay !== undefined ? { ...merchantDay } : {
      id: ids.merchantDay(chainId, merchant, date),
      chainId,
      merchant_id: ids.account(chainId, merchant),
      date,
      dayStart,
      ...EMPTY_DAY,
    },
  };
}

/**
 * Writes the days. With `snapshot`, for the day the books are current on, their active count and
 * MRR are copied in as the day's latest. A past day that a late count lands on (an expiry the
 * sweep found after midnight) keeps its own, unless the count is what creates its row.
 */
export function closeDays(context: Context, days: Days, books: Pick<Books, "network" | "merchant">, snapshot = true): void {
  context.DailyStat.set(
    snapshot || days.fresh.day ? { ...days.day, activeMandates: books.network.activeMandates, mrr: books.network.mrr } : days.day,
  );
  context.MerchantDailyStat.set(
    snapshot || days.fresh.merchantDay
      ? { ...days.merchantDay, activeMandates: books.merchant.activeMandates, mrr: books.merchant.mrr }
      : days.merchantDay,
  );
}

/** One entry on a mandate's timeline. */
export function timeline(
  context: Context,
  entry: Omit<MandateEvent, "actor" | "amount" | "manager" | "blockNumber" | "transactionHash"> &
    Partial<Pick<MandateEvent, "actor" | "amount" | "manager" | "blockNumber" | "transactionHash">>,
): void {
  context.MandateEvent.set({
    actor: undefined,
    amount: undefined,
    manager: undefined,
    blockNumber: undefined,
    transactionHash: undefined,
    ...entry,
  });
}

/** The aggregates one meter feeds. */
export interface MeterBooks {
  network: Mutable<Network>;
  merchant: Mutable<Merchant>;
  merchantAsset: Mutable<MerchantAsset>;
  payer: Mutable<Payer>;
}

/**
 * The books for one meter's parties, created empty where this is the first time they are seen. A
 * party is counted as a meter merchant or payer at its first meter, which is the only event that
 * opens these books for a party with none.
 */
export async function openMeterBooks(context: Context, parties: Parties, now: bigint): Promise<MeterBooks> {
  const { chainId, merchant, payer, asset } = parties;
  const [network, merchantRow, merchantAsset, payerRow] = await Promise.all([
    context.Network.get(ids.network(chainId)),
    context.Merchant.get(ids.account(chainId, merchant)),
    context.MerchantAsset.get(ids.accountAsset(chainId, merchant, asset)),
    context.Payer.get(ids.account(chainId, payer)),
  ]);
  const books: MeterBooks = {
    network: network === undefined ? newNetwork(chainId, now) : { ...network },
    merchant: merchantRow !== undefined ? { ...merchantRow } : newMerchant(chainId, merchant, now),
    merchantAsset: merchantAsset !== undefined ? { ...merchantAsset } : newMerchantAsset(chainId, merchant, asset),
    payer: payerRow !== undefined ? { ...payerRow } : newPayer(chainId, payer, now),
  };
  if ((merchantRow?.meterCount ?? 0) === 0) books.network.meterMerchantCount += 1;
  if ((payerRow?.meterCount ?? 0) === 0) books.network.meterPayerCount += 1;
  return books;
}

export function closeMeterBooks(context: Context, books: MeterBooks): void {
  context.Network.set(books.network);
  context.Merchant.set(books.merchant);
  context.MerchantAsset.set(books.merchantAsset);
  context.Payer.set(books.payer);
}

/**
 * `draft` with its standing evaluated at `now`, and the change from `before` (none for a new
 * meter) carried into every meter count in `books`.
 */
export function restateMeter(books: MeterBooks, before: Meter | undefined, draft: Meter, now: bigint): Meter {
  const standing = meterStandingOf(draft, now);
  const after: Meter = {
    ...draft,
    standing,
    ended: isMeterEnded(standing),
    standingAsOf: now,
    remaining: draft.maxTotal - draft.totalCharged,
  };

  const from: MeterStanding | undefined = before?.standing;
  if (from !== standing) {
    books.network = moveMeterCount(books.network, from, standing);
    books.merchant = moveMeterCount(books.merchant, from, standing);
    books.payer = moveMeterCount(books.payer, from, standing);
    const wasOpen = from !== undefined && !isMeterEnded(from);
    books.network.openMeters += (isMeterEnded(standing) ? 0 : 1) - (wasOpen ? 1 : 0);
  }

  if (now > books.network.standingAsOf) books.network.standingAsOf = now;
  return after;
}
