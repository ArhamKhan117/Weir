/**
 * `MandateMeter` events into meters, settlements, failures and the meter figures they feed.
 *
 * As with the hub, each handler restates the meter exactly as the contract changed it, from the
 * event alone: creation carries every term, `UsageSettled` the new total, and both settlement
 * events roll the period by the rule `_roll` applies. No handler reads the chain, and the result
 * matches `getMeter` field for field (`pnpm verify` checks it).
 *
 * Meter money is kept apart from mandate money: a settlement adds to `meteredRevenue`,
 * `meteredPaid` and `meteredVolume`, never to `revenue`, `totalPaid` or `volume`.
 */

import { indexer, type Meter } from "envio";

import {
  assetSymbol,
  closeDays,
  closeMeterBooks,
  ids,
  openDays,
  openMeterBooks,
  partiesOf,
  restateMeter,
  type Context,
  type Days,
  type MeterBooks,
} from "../books.js";
import { ZERO_ADDRESS, failureReason, rolledPeriod } from "../model.js";

/** The meter an event is about, with the books and days it feeds. */
async function open(context: Context, chainId: number, meterId: bigint, now: bigint) {
  const before = await context.Meter.getOrThrow(ids.meter(chainId, meterId));
  const parties = partiesOf(before);
  const [books, days] = await Promise.all([
    openMeterBooks(context, parties, now),
    openDays(context, chainId, parties.merchant, now),
  ]);
  return { before, books, days };
}

function close(context: Context, meter: Meter, books: MeterBooks, days: Days): void {
  context.Meter.set(meter);
  closeMeterBooks(context, books);
  closeDays(context, days, books);
}

indexer.onEvent({ contract: "MandateMeter", event: "MeterCreated" }, async ({ event, context }) => {
  const { chainId, block, transaction, params: p } = event;
  const now = BigInt(block.timestamp);
  const parties = { chainId, merchant: p.merchant, payer: p.payer, asset: p.asset };
  const [books, days] = await Promise.all([openMeterBooks(context, parties, now), openDays(context, chainId, p.merchant, now)]);

  const meter = restateMeter(
    books,
    undefined,
    {
      id: ids.meter(chainId, p.meterId),
      chainId,
      contract: event.srcAddress,
      meterId: p.meterId,
      payer_id: books.payer.id,
      merchant_id: books.merchant.id,
      asset: p.asset,
      assetSymbol: assetSymbol(chainId, p.asset),
      manager: p.manager,
      periodCap: p.periodCap,
      period: Number(p.period),
      maxTotal: p.maxTotal,
      expiresAt: p.expiresAt,
      ref: p.ref,
      status: "Active",
      // Placeholders `restateMeter` replaces.
      standing: "Active",
      ended: false,
      standingAsOf: now,
      remaining: p.maxTotal,
      totalCharged: 0n,
      // `_create` starts the first period at creation.
      periodStart: now,
      periodCharged: 0n,
      receiptTotal: 0n,
      settlementCount: 0,
      failureCount: 0,
      lastSettledAt: undefined,
      lastFailureAt: undefined,
      lastFailureReason: undefined,
      lastFailureAmount: undefined,
      createdAt: now,
      createdBlock: block.number,
      createdTx: transaction.hash,
      closedAt: 0n,
      closedBlock: undefined,
      closedTx: undefined,
      cancelledBy: undefined,
    },
    now,
  );

  books.network.meterCount += 1;
  books.merchant.meterCount += 1;
  books.payer.meterCount += 1;
  days.day.newMeters += 1;
  days.merchantDay.newMeters += 1;
  close(context, meter, books, days);
});

indexer.onEvent({ contract: "MandateMeter", event: "UsageSettled" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  const now = BigInt(block.timestamp);
  const { before, books, days } = await open(context, chainId, p.meterId, now);
  const amount = p.amount;
  const period = rolledPeriod(before.periodStart, before.periodCharged, before.period, now);

  const meter = restateMeter(
    books,
    before,
    {
      ...before,
      totalCharged: p.totalCharged,
      periodStart: period.periodStart,
      periodCharged: period.periodCharged + amount,
      receiptTotal: p.receiptTotal,
      // A funded settlement clears delinquency; a cancelled meter stays cancelled.
      status: before.status === "Cancelled" ? "Cancelled" : "Active",
      settlementCount: before.settlementCount + 1,
      lastSettledAt: now,
    },
    now,
  );

  books.network.meterSettlementCount += 1;
  books.network.meteredVolume += amount;
  books.merchant.meterSettlements += 1;
  books.merchant.meteredRevenue += amount;
  books.merchantAsset.meterSettlements += 1;
  books.merchantAsset.meteredRevenue += amount;
  books.payer.meterSettlements += 1;
  books.payer.meteredPaid += amount;
  days.day.meterSettlements += 1;
  days.day.meteredVolume += amount;
  days.merchantDay.meterSettlements += 1;
  days.merchantDay.meteredVolume += amount;
  close(context, meter, books, days);

  context.MeterSettlement.set({
    id: ids.log(chainId, transaction.hash, logIndex),
    chainId,
    meter_id: meter.id,
    payer_id: meter.payer_id,
    merchant_id: meter.merchant_id,
    asset: meter.asset,
    assetSymbol: meter.assetSymbol,
    amount,
    totalCharged: p.totalCharged,
    receiptTotal: p.receiptTotal,
    sender: transaction.from ?? ZERO_ADDRESS,
    timestamp: now,
    blockNumber: block.number,
    transactionHash: transaction.hash,
    logIndex,
  });
});

indexer.onEvent({ contract: "MandateMeter", event: "SettleFailed" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  const now = BigInt(block.timestamp);
  const { before, books, days } = await open(context, chainId, p.meterId, now);
  const reasonCode = Number(p.reason);
  const reason = failureReason(reasonCode);
  // The roll happens before the payer's funds are checked, and a failure does not revert it.
  const period = rolledPeriod(before.periodStart, before.periodCharged, before.period, now);

  const meter = restateMeter(
    books,
    before,
    {
      ...before,
      ...period,
      status: before.status === "Cancelled" ? "Cancelled" : "Delinquent",
      failureCount: before.failureCount + 1,
      lastFailureAt: now,
      lastFailureReason: reason,
      lastFailureAmount: p.required,
    },
    now,
  );

  books.network.meterFailureCount += 1;
  books.merchant.meterFailures += 1;
  books.payer.meterFailures += 1;
  days.day.meterFailures += 1;
  days.merchantDay.meterFailures += 1;
  close(context, meter, books, days);

  context.MeterSettleFailure.set({
    id: ids.log(chainId, transaction.hash, logIndex),
    chainId,
    meter_id: meter.id,
    payer_id: meter.payer_id,
    merchant_id: meter.merchant_id,
    asset: meter.asset,
    assetSymbol: meter.assetSymbol,
    reason,
    reasonCode,
    required: p.required,
    sender: transaction.from ?? ZERO_ADDRESS,
    timestamp: now,
    blockNumber: block.number,
    transactionHash: transaction.hash,
    logIndex,
  });
});

indexer.onEvent({ contract: "MandateMeter", event: "MeterCancelled" }, async ({ event, context }) => {
  const { chainId, block, transaction, params: p } = event;
  const now = BigInt(block.timestamp);
  const { before, books, days } = await open(context, chainId, p.meterId, now);

  const meter = restateMeter(
    books,
    before,
    { ...before, status: "Cancelled", closedAt: now, closedBlock: block.number, closedTx: transaction.hash, cancelledBy: p.by },
    now,
  );
  close(context, meter, books, days);
});

indexer.onEvent({ contract: "MandateMeter", event: "NonceInvalidated" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  context.NonceInvalidation.set({
    id: ids.log(chainId, transaction.hash, logIndex),
    chainId,
    contract: event.srcAddress,
    signer: p.signer,
    nonce: p.nonce,
    timestamp: BigInt(block.timestamp),
    blockNumber: block.number,
    transactionHash: transaction.hash,
  });
});
