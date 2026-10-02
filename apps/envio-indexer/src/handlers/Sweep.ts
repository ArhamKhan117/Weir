/**
 * Expiry, which no event announces.
 *
 * A mandate is expired from the first second after its `expiresAt`, whether anyone looks or not,
 * and an expired mandate leaves its merchant's MRR, its payer's commitment and every active count.
 * This block handler finds the mandates that have passed their expiry and restates them. At the
 * head it runs about every minute; while the indexer catches up it runs about every hour of
 * blocks, since the figures only need to be right by the time they are read. Either way each
 * expiry is dated to its own day in the daily series, not to the sweep that found it.
 *
 * A pass needs the block's time from an RPC (see `clock.ts`), and makes no call at all while
 * nothing is open.
 */

import { indexer } from "envio";

import { closeBooks, closeDays, ids, networkInfo, openBooks, openDays, partiesOf, restate, timeline } from "../books.js";
import { blockTime } from "../clock.js";
import { dayOf } from "../model.js";
import { NETWORKS } from "../networks.js";

/**
 * Blocks between passes at the head: about a minute on Monad (Testnet runs at about three blocks a
 * second, Mainnet at two and a half). Each pass counts as one processed event on the hosted
 * service's plan limits.
 */
export const SWEEP_EVERY_BLOCKS = 180;

/** While catching up, only one pass in this many runs: every 10,800 blocks, about an hour. */
export const HISTORICAL_STRIDE = 60;

indexer.onBlock(
  {
    name: "ExpirySweep",
    where: ({ chain }) => {
      const info = NETWORKS[chain.id];
      if (info === undefined) return false;
      return { block: { number: { _gte: info.startBlock, _every: SWEEP_EVERY_BLOCKS } } };
    },
  },
  async ({ block, context }) => {
    const chainId = context.chain.id;
    const pass = (block.number - networkInfo(chainId).startBlock) / SWEEP_EVERY_BLOCKS;
    if (!context.chain.isRealtime && pass % HISTORICAL_STRIDE !== 0) return;

    const network = await context.Network.get(ids.network(chainId));
    if (network === undefined || network.openMandates === 0) return;
    const time = await context.effect(blockTime, block.number);
    if (time === null) return;
    const now = BigInt(time);

    const due = await context.Mandate.getWhere({ ended: { _eq: false }, expiresAt: { _lt: now } });
    const ordered = [...due].sort((a, b) => (a.mandateId < b.mandateId ? -1 : a.mandateId > b.mandateId ? 1 : 0));

    for (const before of ordered) {
      const parties = partiesOf(before);
      const expiredAt = before.expiresAt + 1n;
      const sameDay = dayOf(expiredAt).date === dayOf(now).date;
      const [books, expiryDays, today] = await Promise.all([
        openBooks(context, parties, now),
        openDays(context, chainId, parties.merchant, expiredAt),
        sameDay ? undefined : openDays(context, chainId, parties.merchant, now),
      ]);

      const mandate = restate(books, before, before, now);
      expiryDays.day.expirations += 1;
      expiryDays.merchantDay.expirations += 1;
      context.Mandate.set(mandate);
      closeBooks(context, books);
      closeDays(context, expiryDays, books, sameDay);
      if (today !== undefined) closeDays(context, today, books);
      timeline(context, {
        id: `${mandate.id}-expired`,
        chainId,
        mandate_id: mandate.id,
        kind: "Expired",
        timestamp: expiredAt,
      });
    }

    const current = (await context.Network.get(ids.network(chainId))) ?? network;
    if (now > current.standingAsOf) context.Network.set({ ...current, standingAsOf: now });
  },
);
