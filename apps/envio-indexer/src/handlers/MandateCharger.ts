/**
 * `MandateCharger` events: batch charges that reverted, and Chainlink CRE reports.
 *
 * A report's charges run before its `ReportCharged`, inside `onReport`, so when the report arrives
 * every `Charged`, `ChargeFailed` and `ChargeReverted` it caused is already indexed under the same
 * transaction. The report finds them by transaction hash, links them to itself, marks them as
 * sent by CRE, and records what they came to.
 */

import { indexer } from "envio";

import { ids, networkInfo, newNetwork, openDay } from "../books.js";
import { ZERO_ADDRESS, triggerOf } from "../model.js";
import { REVERT_REASONS } from "../networks.js";

indexer.onEvent({ contract: "MandateCharger", event: "ChargeReverted" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  const selector = p.reason.toLowerCase();
  context.ChargeRevert.set({
    id: ids.log(chainId, transaction.hash, logIndex),
    chainId,
    mandateId: p.mandateId,
    mandate_id: ids.mandate(chainId, p.mandateId),
    selector,
    error: REVERT_REASONS[selector],
    // Only a batch emits this: through a CRE report, or `chargeMany` from the keeper or anyone.
    trigger: triggerOf(transaction.to, networkInfo(chainId)) === "Cre" ? "Cre" : "Keeper",
    report_id: undefined,
    sender: transaction.from ?? ZERO_ADDRESS,
    timestamp: BigInt(block.timestamp),
    blockNumber: block.number,
    transactionHash: transaction.hash,
    logIndex,
  });
});

indexer.onEvent({ contract: "MandateCharger", event: "ReportCharged" }, async ({ event, context }) => {
  const { chainId, block, transaction, logIndex, params: p } = event;
  const now = BigInt(block.timestamp);
  const inTransaction = { transactionHash: { _eq: transaction.hash } };
  const [charges, failures, reverts, network, day] = await Promise.all([
    context.Charge.getWhere(inTransaction),
    context.ChargeFailure.getWhere(inTransaction),
    context.ChargeRevert.getWhere(inTransaction),
    context.Network.get(ids.network(chainId)),
    openDay(context, chainId, now),
  ]);
  const ours = <T extends { chainId: number; logIndex: number }>(rows: readonly T[]) =>
    rows.filter((row) => row.chainId === chainId && row.logIndex < logIndex);

  const id = ids.log(chainId, transaction.hash, logIndex);
  const reportCharges = ours(charges);
  const reportFailures = ours(failures);
  const reportReverts = ours(reverts);
  for (const charge of reportCharges) context.Charge.set({ ...charge, trigger: "Cre", report_id: id });
  for (const failure of reportFailures) context.ChargeFailure.set({ ...failure, trigger: "Cre", report_id: id });
  for (const revert of reportReverts) context.ChargeRevert.set({ ...revert, trigger: "Cre", report_id: id });

  context.ChargerReport.set({
    id,
    chainId,
    workflowId: p.workflowId,
    forwarder: p.forwarder,
    simulated: p.forwarder === networkInfo(chainId).simulationForwarder,
    attempted: Number(p.attempted),
    charged: Number(p.charged),
    failed: reportFailures.length,
    reverted: reportReverts.length,
    volume: reportCharges.reduce((sum, charge) => sum + charge.amount, 0n),
    sender: transaction.from ?? ZERO_ADDRESS,
    timestamp: now,
    blockNumber: block.number,
    transactionHash: transaction.hash,
  });

  const current = network ?? newNetwork(chainId, now);
  context.Network.set({ ...current, reportCount: current.reportCount + 1 });
  context.DailyStat.set({ ...day, reports: day.reports + 1, activeMandates: current.activeMandates, mrr: current.mrr });
});
