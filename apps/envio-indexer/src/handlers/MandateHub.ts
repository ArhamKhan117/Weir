/**
 * `MandateHub` events into mandates, charges, failures and every aggregate they feed.
 *
 * Each handler restates the mandate exactly as the contract changed it, from the event alone:
 * creation carries every term, `Charged` the new total and schedule, `MandateResumed` moves a
 * stream's checkpoint by the rule `_resume` applies. No handler reads the chain, so a full sync
 * runs at HyperSync's speed, and the result matches `getMandate` field for field (`pnpm verify`
 * checks it).
 *
 * A stream paused or cancelled first settles what it accrued, and its `Charged` or `ChargeFailed`
 * is the log directly before the `MandatePaused` or `MandateCancelled`: the pause or cancel marks
 * that charge as a settlement.
 */

import { indexer, type Mandate } from "envio";

import {
  assetSymbol,
  closeBooks,
  closeDays,
  ids,
  networkInfo,
  openBooks,
  openDays,
  partiesOf,
  restate,
  timeline,
  type Books,
  type Context,
  type Days,
} from "../books.js";
import { ZERO_ADDRESS, failureReason, resumedCheckpoint, triggerOf } from "../model.js";

/** The mandate an event is about, with the books and days it feeds. */
async function open(context: Context, chainId: number, mandateId: bigint, now: bigint) {
  const before = await context.Mandate.getOrThrow(ids.mandate(chainId, mandateId));
  const parties = partiesOf(before);
  const [books, days] = await Promise.all([
    openBooks(context, parties, now),
    openDays(context, chainId, parties.merchant, now),
  ]);
  return { before, books, days };
}

function close(context: Context, mandate: Mandate, books: Books, days: Days): void {
  context.Mandate.set(mandate);
  closeBooks(context, books);
  closeDays(context, days, books);
}

/**
 * Marks the charge or failure one log before a pause or cancel as the stream's settlement, when it
 * is this mandate's.
 */
async function markSettlement(context: Context, chainId: number, mandateId: string, transactionHash: string, logIndex: number) {
  if (logIndex === 0) return;
  const id = ids.log(chainId, transactionHash, logIndex - 1);
  const [charge, failure] = await Promise.all([context.Charge.get(id), context.ChargeFailure.get(id)]);
  if (charge?.mandate_id === mandateId) context.Charge.set({ ...charge, trigger: "Settlement" });
  if (failure?.mandate_id === mandateId) context.ChargeFailure.set({ ...failure, trigger: "Settlement" });
}

indexer.onEvent({ contract: "MandateHub", event: "MandateCreated" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  const now = BigInt(block.timestamp);
  const parties = { chainId, merchant: p.merchant, payer: p.payer, asset: p.asset };
  const [books, days] = await Promise.all([openBooks(context, parties, now), openDays(context, chainId, p.merchant, now)]);

  const period = Number(p.period);
  const mandate = restate(
    books,
    undefined,
    {
      id: ids.mandate(chainId, p.mandateId),
      chainId,
      hub: event.srcAddress,
      mandateId: p.mandateId,
      payer_id: books.payer.id,
      merchant_id: books.merchant.id,
      customer_id: books.customer.id,
      asset: p.asset,
      assetSymbol: assetSymbol(chainId, p.asset),
      vault: p.vault,
      fromSavings: p.vault !== ZERO_ADDRESS,
      manager: p.manager,
      mode: period === 0 ? "Streaming" : "Periodic",
      amount: p.amount,
      period,
      startsAt: p.nextChargeAt,
      nextChargeAt: p.nextChargeAt,
      maxPerCharge: p.maxPerCharge,
      maxTotal: p.maxTotal,
      expiresAt: p.expiresAt,
      ref: p.ref,
      status: "Active",
      // Placeholders `restate` replaces.
      standing: "Active",
      ended: false,
      standingAsOf: now,
      remaining: p.maxTotal,
      mrr: 0n,
      committedMonthly: 0n,
      pausedAt: 0n,
      totalCharged: 0n,
      chargeCount: 0,
      failureCount: 0,
      lastChargedAt: undefined,
      lastFailureAt: undefined,
      lastFailureReason: undefined,
      lastFailureAmount: undefined,
      createdAt: now,
      createdBlock: block.number,
      createdTx: transaction.hash,
      cancelledAt: undefined,
      cancelledBlock: undefined,
      cancelledTx: undefined,
      cancelledBy: undefined,
      pauseCount: 0,
    },
    now,
  );

  books.network.mandateCount += 1;
  books.merchant.mandateCount += 1;
  books.payer.mandateCount += 1;
  books.customer.mandateCount += 1;
  days.day.newMandates += 1;
  days.merchantDay.newMandates += 1;
  close(context, mandate, books, days);
  timeline(context, {
    id: ids.log(chainId, transaction.hash, logIndex),
    chainId,
    mandate_id: mandate.id,
    kind: "Created",
    actor: p.payer,
    amount: p.amount,
    timestamp: now,
    blockNumber: block.number,
    transactionHash: transaction.hash,
  });
});

indexer.onEvent({ contract: "MandateHub", event: "Charged" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  const now = BigInt(block.timestamp);
  const { before, books, days } = await open(context, chainId, p.mandateId, now);
  const amount = p.amount;

  const mandate = restate(
    books,
    before,
    {
      ...before,
      totalCharged: p.totalCharged,
      nextChargeAt: p.nextChargeAt,
      // `_book` clears delinquency; a cancelled mandate is never charged.
      status: before.status === "Cancelled" ? "Cancelled" : "Active",
      chargeCount: before.chargeCount + 1,
      lastChargedAt: now,
    },
    now,
  );

  books.network.chargeCount += 1;
  books.network.volume += amount;
  books.merchant.chargeCount += 1;
  books.merchant.revenue += amount;
  books.merchantAsset.chargeCount += 1;
  books.merchantAsset.revenue += amount;
  books.payer.chargeCount += 1;
  books.payer.totalPaid += amount;
  books.payerAsset.chargeCount += 1;
  books.payerAsset.totalPaid += amount;
  books.customer.chargeCount += 1;
  books.customer.totalPaid += amount;
  books.customer.lastChargedAt = now;
  days.day.charges += 1;
  days.day.volume += amount;
  days.merchantDay.charges += 1;
  days.merchantDay.volume += amount;
  close(context, mandate, books, days);

  const id = ids.log(chainId, transaction.hash, logIndex);
  const sender = transaction.from ?? ZERO_ADDRESS;
  // The hub announces a charge the balance paid for a savings mandate in the log just before it.
  const fallback = logIndex === 0 ? undefined : await context.BalanceFallback.get(ids.log(chainId, transaction.hash, logIndex - 1));
  context.Charge.set({
    id,
    chainId,
    mandate_id: mandate.id,
    payer_id: mandate.payer_id,
    merchant_id: mandate.merchant_id,
    asset: mandate.asset,
    assetSymbol: mandate.assetSymbol,
    amount,
    totalCharged: p.totalCharged,
    nextChargeAt: p.nextChargeAt,
    trigger: triggerOf(transaction.to, networkInfo(chainId)),
    fromBalance: fallback?.mandate_id === mandate.id,
    report_id: undefined,
    sender,
    timestamp: now,
    blockNumber: block.number,
    transactionHash: transaction.hash,
    logIndex,
  });
  timeline(context, {
    id,
    chainId,
    mandate_id: mandate.id,
    kind: "Charged",
    actor: sender,
    amount,
    timestamp: now,
    blockNumber: block.number,
    transactionHash: transaction.hash,
  });
});

indexer.onEvent({ contract: "MandateHub", event: "ChargedFromBalance" }, async ({ event, context }) => {
  const { chainId, transaction, logIndex, params: p } = event;
  context.BalanceFallback.set({
    id: ids.log(chainId, transaction.hash, logIndex),
    chainId,
    mandate_id: ids.mandate(chainId, p.mandateId),
    amount: p.amount,
  });
});

indexer.onEvent({ contract: "MandateHub", event: "ChargeFailed" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  const now = BigInt(block.timestamp);
  const { before, books, days } = await open(context, chainId, p.mandateId, now);
  const reasonCode = Number(p.reason);
  const reason = failureReason(reasonCode);

  const mandate = restate(
    books,
    before,
    {
      ...before,
      status: before.status === "Cancelled" ? "Cancelled" : "Delinquent",
      failureCount: before.failureCount + 1,
      lastFailureAt: now,
      lastFailureReason: reason,
      lastFailureAmount: p.required,
    },
    now,
  );

  books.network.failureCount += 1;
  books.merchant.failureCount += 1;
  books.merchantAsset.failureCount += 1;
  books.payer.failureCount += 1;
  books.payerAsset.failureCount += 1;
  days.day.failures += 1;
  days.merchantDay.failures += 1;
  close(context, mandate, books, days);

  const id = ids.log(chainId, transaction.hash, logIndex);
  const sender = transaction.from ?? ZERO_ADDRESS;
  context.ChargeFailure.set({
    id,
    chainId,
    mandate_id: mandate.id,
    payer_id: mandate.payer_id,
    merchant_id: mandate.merchant_id,
    asset: mandate.asset,
    assetSymbol: mandate.assetSymbol,
    reason,
    reasonCode,
    required: p.required,
    trigger: triggerOf(transaction.to, networkInfo(chainId)),
    report_id: undefined,
    sender,
    timestamp: now,
    blockNumber: block.number,
    transactionHash: transaction.hash,
    logIndex,
  });
  timeline(context, {
    id,
    chainId,
    mandate_id: mandate.id,
    kind: "ChargeFailed",
    actor: sender,
    amount: p.required,
    timestamp: now,
    blockNumber: block.number,
    transactionHash: transaction.hash,
  });
});

indexer.onEvent({ contract: "MandateHub", event: "MandateCancelled" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  const now = BigInt(block.timestamp);
  const { before, books, days } = await open(context, chainId, p.mandateId, now);

  const mandate = restate(
    books,
    before,
    {
      ...before,
      status: "Cancelled",
      cancelledAt: now,
      cancelledBlock: block.number,
      cancelledTx: transaction.hash,
      cancelledBy: p.by,
    },
    now,
  );
  days.day.cancellations += 1;
  days.merchantDay.cancellations += 1;
  close(context, mandate, books, days);

  // `_cancel` settles a running stream, never a paused one or a periodic mandate.
  if (before.period === 0 && before.pausedAt === 0n) {
    await markSettlement(context, chainId, mandate.id, transaction.hash, logIndex);
  }
  timeline(context, {
    id: ids.log(chainId, transaction.hash, logIndex),
    chainId,
    mandate_id: mandate.id,
    kind: "Cancelled",
    actor: p.by,
    timestamp: now,
    blockNumber: block.number,
    transactionHash: transaction.hash,
  });
});

indexer.onEvent({ contract: "MandateHub", event: "MandatePaused" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  const now = BigInt(block.timestamp);
  const { before, books, days } = await open(context, chainId, p.mandateId, now);

  const mandate = restate(books, before, { ...before, pausedAt: now, pauseCount: before.pauseCount + 1 }, now);
  close(context, mandate, books, days);

  await markSettlement(context, chainId, mandate.id, transaction.hash, logIndex);
  timeline(context, {
    id: ids.log(chainId, transaction.hash, logIndex),
    chainId,
    mandate_id: mandate.id,
    kind: "Paused",
    actor: p.by,
    timestamp: now,
    blockNumber: block.number,
    transactionHash: transaction.hash,
  });
});

indexer.onEvent({ contract: "MandateHub", event: "MandateResumed" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  const now = BigInt(block.timestamp);
  const { before, books, days } = await open(context, chainId, p.mandateId, now);

  const mandate = restate(
    books,
    before,
    { ...before, pausedAt: 0n, nextChargeAt: resumedCheckpoint(before.nextChargeAt, before.pausedAt, now) },
    now,
  );
  close(context, mandate, books, days);
  timeline(context, {
    id: ids.log(chainId, transaction.hash, logIndex),
    chainId,
    mandate_id: mandate.id,
    kind: "Resumed",
    actor: p.by,
    timestamp: now,
    blockNumber: block.number,
    transactionHash: transaction.hash,
  });
});

indexer.onEvent({ contract: "MandateHub", event: "ManagerChanged" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  const now = BigInt(block.timestamp);
  const { before, books, days } = await open(context, chainId, p.mandateId, now);

  // The standing is evaluated again too: a mandate past its expiry but not yet swept is expired now.
  const mandate = restate(books, before, { ...before, manager: p.manager }, now);
  close(context, mandate, books, days);
  timeline(context, {
    id: ids.log(chainId, transaction.hash, logIndex),
    chainId,
    mandate_id: mandate.id,
    kind: "ManagerChanged",
    // Only the payer can change the manager, directly or by signature.
    actor: partiesOf(before).payer,
    manager: p.manager,
    timestamp: now,
    blockNumber: block.number,
    transactionHash: transaction.hash,
  });
});

indexer.onEvent({ contract: "MandateHub", event: "NonceInvalidated" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  context.NonceInvalidation.set({
    id: ids.log(chainId, transaction.hash, logIndex),
    chainId,
    signer: p.signer,
    nonce: p.nonce,
    timestamp: BigInt(block.timestamp),
    blockNumber: block.number,
    transactionHash: transaction.hash,
  });
});
