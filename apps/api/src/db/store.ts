/**
 * Every query the routes and the indexer make, in one place.
 *
 * Reads over the index are scoped to one chain id and hub. Merchants are not: a merchant is a
 * person with a payout address, and the same person can sell on Testnet and on Mainnet.
 *
 * Two joins carry the product's rules and are worth reading before changing either:
 *
 * - **A merchant's mandates** are those paying any address in the merchant's payout history, so a
 *   changed payout address never hides mandates still paying the old one.
 * - **A mandate's plan** is the plan whose `ref` it carries, and only when the mandate pays that
 *   plan's merchant. `ref` is chosen by whoever signs the terms, so without the second condition
 *   anyone could label a mandate paying themselves with a real merchant's plan name.
 * - **A mandate's support circle** is joined by the same rule: the circle whose `ref` it carries,
 *   only when the mandate pays that circle's recipient.
 */

import { refFromString, type ChargeView, type MandateView, type Plan, type SupportCircle, type Supporter } from "@weir/shared";
import type { Address, Hex } from "viem";

import type { ValidPlan } from "../domain/plans.js";
import type { ValidSupport } from "../domain/support.js";
import { newMerchantId } from "../domain/ids.js";
import {
  toChargeView,
  toMandateView,
  toPlan,
  toSupportCircle,
  type ChargeRow,
  type MandateRow,
  type MerchantRow,
  type PlanRow,
  type SupportRow,
} from "../domain/views.js";
import { newWebhookSecret } from "../webhooks/sign.js";
import type { Db, Fragment, Sql } from "./database.js";

export interface IndexScope {
  chainId: number;
  hub: Address;
}

export type MandateFilter =
  | { readonly payer: Address }
  | { readonly merchantId: string }
  | { readonly mandateId: bigint }
  /** A support circle's contributions: its `ref`, paying its recipient. */
  | { readonly ref: Hex; readonly merchant: Address };

/** A browser's Web Push subscription: where to send, and the keys to encrypt for it. */
export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface MerchantPatch {
  name?: string;
  payoutAddress?: Address;
  webhookUrl?: string | null;
}

const MERCHANT_COLUMNS = "id, auth_subject, name, payout_address, webhook_url, webhook_since, created_at";
const SUPPORT_COLUMNS = "id, recipient, name, note, currency, asset, period, goal, created_at";

function mandateWhere(db: Db, filter: MandateFilter) {
  if ("payer" in filter) return db`m.payer = ${filter.payer}`;
  if ("merchantId" in filter) {
    return db`m.merchant IN (SELECT address FROM merchant_payouts WHERE merchant_id = ${filter.merchantId})`;
  }
  if ("ref" in filter) return db`m.ref = ${filter.ref} AND m.merchant = ${filter.merchant}`;
  return db`m.id = ${filter.mandateId.toString()}`;
}

/** Mandate rows with their plan joined, newest first. */
export async function selectMandateRows(db: Db, scope: IndexScope, filter: MandateFilter, limit: number): Promise<MandateRow[]> {
  return db<MandateRow[]>`
    SELECT m.id, m.payer, m.merchant, m.asset, m.vault, m.manager, m.amount, m.period, m.next_charge_at,
           m.max_per_charge, m.max_total, m.total_charged, m.expires_at, m.paused_at, m.status, m.ref,
           m.created_at, m.created_tx,
           pj.id AS plan_id, pj.name AS plan_name, pj.description AS plan_description, pj.mode AS plan_mode,
           pj.merchant_name AS plan_merchant_name,
           sj.id AS support_id, sj.name AS support_name, sn.name AS supporter_name
    FROM mandates m
    LEFT JOIN LATERAL (
      SELECT p.id, p.name, p.description, p.mode, mer.name AS merchant_name
      FROM plans p
      JOIN merchants mer ON mer.id = p.merchant_id
      WHERE p.chain_id = m.chain_id
        AND p.ref = m.ref
        AND EXISTS (SELECT 1 FROM merchant_payouts mp WHERE mp.merchant_id = p.merchant_id AND mp.address = m.merchant)
      LIMIT 1
    ) pj ON true
    LEFT JOIN LATERAL (
      SELECT s.id, s.name FROM support_circles s
      WHERE s.chain_id = m.chain_id AND s.ref = m.ref AND s.recipient = m.merchant
      LIMIT 1
    ) sj ON true
    LEFT JOIN LATERAL (
      SELECT n.name FROM supporter_names n
      WHERE n.chain_id = m.chain_id AND n.hub = m.hub AND n.mandate_id = m.id AND n.signer IN (m.payer, m.manager)
      ORDER BY n.updated_at DESC
      LIMIT 1
    ) sn ON true
    WHERE m.chain_id = ${scope.chainId} AND m.hub = ${scope.hub} AND ${mandateWhere(db, filter)}
    ORDER BY m.created_block DESC, m.id DESC
    LIMIT ${limit}`;
}

/** Charges on the filtered mandates, newest first. */
export async function selectChargeRows(db: Db, scope: IndexScope, filter: MandateFilter, limit: number): Promise<ChargeRow[]> {
  return db<ChargeRow[]>`
    SELECT c.mandate_id, c.kind, c.amount, c.reason, c.block_time, c.block_number, c.tx_hash,
           m.payer, m.merchant, m.asset
    FROM charges c
    JOIN mandates m ON m.chain_id = c.chain_id AND m.hub = c.hub AND m.id = c.mandate_id
    WHERE c.chain_id = ${scope.chainId} AND c.hub = ${scope.hub} AND ${mandateWhere(db, filter)}
    ORDER BY c.block_number DESC, c.log_index DESC
    LIMIT ${limit}`;
}

export class Store {
  constructor(
    readonly sql: Sql,
    readonly scope: IndexScope,
    private readonly symbolFor: (asset: Address) => string,
  ) {}

  /*//////////////////////////////////////////////////////////////
                              MERCHANTS
  //////////////////////////////////////////////////////////////*/

  /** The merchant signed in as `subject`, when it has signed in before. */
  async findMerchant(subject: string): Promise<MerchantRow | undefined> {
    const [row] = await this.sql<MerchantRow[]>`SELECT ${this.sql.unsafe(MERCHANT_COLUMNS)} FROM merchants WHERE auth_subject = ${subject}`;
    return row;
  }

  /**
   * The merchant signed in as `subject`, created on first sight with `payoutAddress`, the first
   * wallet it has proven it controls, or with none when it has none yet.
   */
  async ensureMerchant(subject: string, nowSeconds: number, payoutAddress?: Address): Promise<MerchantRow> {
    return this.sql.begin(async (tx) => {
      const inserted = await tx<MerchantRow[]>`
        INSERT INTO merchants (id, auth_subject, name, payout_address, webhook_secret, created_at)
        VALUES (${newMerchantId()}, ${subject}, '', ${payoutAddress ?? null}, ${newWebhookSecret()}, ${nowSeconds})
        ON CONFLICT (auth_subject) DO NOTHING
        RETURNING ${tx.unsafe(MERCHANT_COLUMNS)}`;
      const created = inserted[0];
      if (created !== undefined) {
        if (payoutAddress !== undefined) {
          await tx`INSERT INTO merchant_payouts (merchant_id, address, added_at) VALUES (${created.id}, ${payoutAddress}, ${nowSeconds}) ON CONFLICT DO NOTHING`;
        }
        return created;
      }
      const [existing] = await tx<MerchantRow[]>`SELECT ${tx.unsafe(MERCHANT_COLUMNS)} FROM merchants WHERE auth_subject = ${subject}`;
      if (existing === undefined) throw new Error("merchant vanished between insert and read");
      return existing;
    });
  }

  /**
   * Applies `patch`. When it sets a webhook URL and the merchant's secret has never been shown,
   * the secret is returned, exactly once: the reveal flag flips in the same statement that reads
   * it, so two concurrent requests cannot both receive it.
   */
  async updateMerchant(id: string, patch: MerchantPatch, nowSeconds: number): Promise<{ row: MerchantRow; webhookSecret?: string }> {
    return this.sql.begin(async (tx) => {
      const [current] = await tx<MerchantRow[]>`SELECT ${tx.unsafe(MERCHANT_COLUMNS)} FROM merchants WHERE id = ${id} FOR UPDATE`;
      if (current === undefined) throw new Error(`merchant ${id} does not exist`);

      if (patch.name !== undefined) await tx`UPDATE merchants SET name = ${patch.name} WHERE id = ${id}`;
      if (patch.payoutAddress !== undefined) {
        await tx`UPDATE merchants SET payout_address = ${patch.payoutAddress} WHERE id = ${id}`;
        await tx`INSERT INTO merchant_payouts (merchant_id, address, added_at) VALUES (${id}, ${patch.payoutAddress}, ${nowSeconds}) ON CONFLICT DO NOTHING`;
      }
      let webhookSecret: string | undefined;
      if (patch.webhookUrl === null) {
        await tx`UPDATE merchants SET webhook_url = NULL, webhook_since = NULL WHERE id = ${id}`;
      } else if (patch.webhookUrl !== undefined) {
        // Events from before the URL was set are not replayed at it.
        const since = current.webhook_url === null ? nowSeconds : Number(current.webhook_since ?? nowSeconds);
        await tx`UPDATE merchants SET webhook_url = ${patch.webhookUrl}, webhook_since = ${since} WHERE id = ${id}`;
        const [revealed] = await tx<{ webhook_secret: string }[]>`
          UPDATE merchants SET webhook_secret_revealed = true
          WHERE id = ${id} AND NOT webhook_secret_revealed
          RETURNING webhook_secret`;
        webhookSecret = revealed?.webhook_secret;
      }
      const [row] = await tx<MerchantRow[]>`SELECT ${tx.unsafe(MERCHANT_COLUMNS)} FROM merchants WHERE id = ${id}`;
      if (row === undefined) throw new Error(`merchant ${id} vanished`);
      return webhookSecret === undefined ? { row } : { row, webhookSecret };
    });
  }

  /*//////////////////////////////////////////////////////////////
                                PLANS
  //////////////////////////////////////////////////////////////*/

  private async planRows(where: Fragment, limit = 1_000): Promise<PlanRow[]> {
    return this.sql<PlanRow[]>`
      SELECT p.id, p.name, p.description, p.asset, p.mode, p.amount, p.period, p.trial_days, p.max_per_charge,
             p.max_total, p.term_seconds, p.active, p.created_at,
             mer.id AS merchant_id, mer.name AS merchant_name, mer.payout_address AS merchant_payout
      FROM plans p
      JOIN merchants mer ON mer.id = p.merchant_id
      WHERE p.chain_id = ${this.scope.chainId} AND ${where}
      ORDER BY p.created_at DESC, p.id
      LIMIT ${limit}`;
  }

  private plan(row: PlanRow): Plan {
    return toPlan(row, this.symbolFor(row.asset));
  }

  async insertPlan(merchantId: string, id: string, plan: ValidPlan, nowSeconds: number): Promise<Plan> {
    await this.sql`
      INSERT INTO plans (id, chain_id, merchant_id, ref, name, description, asset, mode, amount, period, trial_days,
                         max_per_charge, max_total, term_seconds, active, created_at)
      VALUES (${id}, ${this.scope.chainId}, ${merchantId}, ${refFromString(id)}, ${plan.name}, ${plan.description},
              ${plan.asset}, ${plan.mode}, ${plan.amount.toString()}, ${plan.period}, ${plan.trialDays},
              ${plan.maxPerCharge.toString()}, ${plan.maxTotal.toString()}, ${plan.termSeconds}, true, ${nowSeconds})`;
    const created = await this.getPlan(id);
    if (created === undefined) throw new Error(`plan ${id} vanished after insert`);
    return created;
  }

  async getPlan(id: string): Promise<Plan | undefined> {
    const [row] = await this.planRows(this.sql`p.id = ${id}`, 1);
    return row === undefined ? undefined : this.plan(row);
  }

  /** The plan, when it belongs to `merchantId`. */
  async getMerchantPlan(merchantId: string, id: string): Promise<Plan | undefined> {
    const [row] = await this.planRows(this.sql`p.id = ${id} AND p.merchant_id = ${merchantId}`, 1);
    return row === undefined ? undefined : this.plan(row);
  }

  async listPlans(merchantId: string): Promise<Plan[]> {
    return (await this.planRows(this.sql`p.merchant_id = ${merchantId}`)).map((row) => this.plan(row));
  }

  async setPlanActive(merchantId: string, id: string, active: boolean): Promise<Plan | undefined> {
    const updated = await this.sql`
      UPDATE plans SET active = ${active}
      WHERE id = ${id} AND merchant_id = ${merchantId} AND chain_id = ${this.scope.chainId}
      RETURNING id`;
    return updated.length === 0 ? undefined : this.getMerchantPlan(merchantId, id);
  }

  /*//////////////////////////////////////////////////////////////
                           MANDATES, CHARGES
  //////////////////////////////////////////////////////////////*/

  async mandates(filter: MandateFilter, nowSeconds: number, limit = 1_000): Promise<MandateView[]> {
    const rows = await selectMandateRows(this.sql, this.scope, filter, limit);
    return rows.map((row) => toMandateView(row, this.symbolFor(row.asset), nowSeconds));
  }

  async charges(filter: MandateFilter, limit = 50): Promise<ChargeView[]> {
    return (await selectChargeRows(this.sql, this.scope, filter, limit)).map(toChargeView);
  }

  /** Base units `Charged` moved to the merchant since `sinceSeconds`, per asset symbol. */
  async collectedSince(merchantId: string, sinceSeconds: number): Promise<{ assetSymbol: string; amount: string }[]> {
    const rows = await this.sql<{ asset: Address; amount: string }[]>`
      SELECT m.asset, sum(c.amount) AS amount
      FROM charges c
      JOIN mandates m ON m.chain_id = c.chain_id AND m.hub = c.hub AND m.id = c.mandate_id
      WHERE c.chain_id = ${this.scope.chainId} AND c.hub = ${this.scope.hub}
        AND c.kind = 'charged' AND c.block_time >= ${sinceSeconds}
        AND m.merchant IN (SELECT address FROM merchant_payouts WHERE merchant_id = ${merchantId})
      GROUP BY m.asset`;
    return rows.map((row) => ({ assetSymbol: this.symbolFor(row.asset), amount: row.amount }));
  }

  /*//////////////////////////////////////////////////////////////
                           FAMILY SUPPORT
  //////////////////////////////////////////////////////////////*/

  private support(row: SupportRow): SupportCircle {
    return toSupportCircle(row, this.symbolFor(row.asset));
  }

  /**
   * Opens the circle, or returns the one this signature already opened: a replayed request is
   * the same circle, never a second one.
   */
  async insertSupport(id: string, circle: ValidSupport, nowSeconds: number): Promise<SupportCircle> {
    await this.sql`
      INSERT INTO support_circles (id, chain_id, recipient, ref, name, note, currency, asset, period, goal, signature, created_at)
      VALUES (${id}, ${this.scope.chainId}, ${circle.recipient}, ${refFromString(id)}, ${circle.name}, ${circle.note},
              ${circle.currency}, ${circle.asset}, ${circle.period}, ${circle.goal.toString()}, ${circle.signature.toLowerCase()}, ${nowSeconds})
      ON CONFLICT (chain_id, signature) DO NOTHING`;
    const [row] = await this.sql<SupportRow[]>`
      SELECT ${this.sql.unsafe(SUPPORT_COLUMNS)} FROM support_circles
      WHERE chain_id = ${this.scope.chainId} AND signature = ${circle.signature.toLowerCase()}`;
    if (row === undefined) throw new Error(`support circle ${id} vanished after insert`);
    return this.support(row);
  }

  async getSupport(id: string): Promise<SupportCircle | undefined> {
    const [row] = await this.sql<SupportRow[]>`
      SELECT ${this.sql.unsafe(SUPPORT_COLUMNS)} FROM support_circles WHERE id = ${id} AND chain_id = ${this.scope.chainId}`;
    return row === undefined ? undefined : this.support(row);
  }

  /** The circles `recipient` has opened, newest first. */
  async supportFor(recipient: Address): Promise<SupportCircle[]> {
    const rows = await this.sql<SupportRow[]>`
      SELECT ${this.sql.unsafe(SUPPORT_COLUMNS)} FROM support_circles
      WHERE chain_id = ${this.scope.chainId} AND recipient = ${recipient}
      ORDER BY created_at DESC, id
      LIMIT 100`;
    return rows.map((row) => this.support(row));
  }

  /** Everyone contributing to `circle`, newest first, with the names they gave. */
  async supporters(circle: SupportCircle, nowSeconds: number): Promise<Supporter[]> {
    const filter = { ref: refFromString(circle.id), merchant: circle.recipient };
    const rows = await selectMandateRows(this.sql, this.scope, filter, 1_000);
    return rows.map((row) => {
      const view = toMandateView(row, this.symbolFor(row.asset), nowSeconds);
      return {
        mandateId: view.id,
        payer: view.payer,
        ...(row.supporter_name === null ? {} : { name: row.supporter_name }),
        amount: view.amount,
        once: view.maxTotal === view.amount,
        standing: view.standing,
        totalCharged: view.totalCharged,
        since: view.createdAt,
      };
    });
  }

  /** Base units the circle's contributions have delivered, in total. */
  async supportReceived(circle: SupportCircle): Promise<string> {
    const [row] = await this.sql<{ amount: string | null }[]>`
      SELECT sum(c.amount) AS amount
      FROM charges c
      JOIN mandates m ON m.chain_id = c.chain_id AND m.hub = c.hub AND m.id = c.mandate_id
      WHERE c.chain_id = ${this.scope.chainId} AND c.hub = ${this.scope.hub} AND c.kind = 'charged'
        AND m.ref = ${refFromString(circle.id)} AND m.merchant = ${circle.recipient}`;
    return row?.amount ?? "0";
  }

  /**
   * Records the name `signer` gave mandate `mandateId`. It is shown only while `signer` is the
   * mandate's payer or manager, which the read checks, so this may run before the mandate is
   * indexed and a stranger's row is never shown.
   */
  async setSupporterName(mandateId: bigint, signer: Address, name: string, nowSeconds: number): Promise<void> {
    await this.sql`
      INSERT INTO supporter_names (chain_id, hub, mandate_id, signer, name, updated_at)
      VALUES (${this.scope.chainId}, ${this.scope.hub}, ${mandateId.toString()}, ${signer}, ${name}, ${nowSeconds})
      ON CONFLICT (chain_id, hub, mandate_id, signer) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`;
  }

  /*//////////////////////////////////////////////////////////////
                           PUSH REMINDERS
  //////////////////////////////////////////////////////////////*/

  /** Whether `signer` manages any of `payer`'s mandates: the session key that stops them. */
  async managesAny(payer: Address, signer: Address): Promise<boolean> {
    const [row] = await this.sql<{ found: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM mandates
        WHERE chain_id = ${this.scope.chainId} AND hub = ${this.scope.hub} AND payer = ${payer} AND manager = ${signer}
      ) AS found`;
    return row?.found === true;
  }

  /** Registers a browser for `payer`'s reminders, moving it from any payer it was registered for. */
  async savePushSubscription(payer: Address, subscription: PushSubscriptionRecord, nowSeconds: number): Promise<void> {
    await this.sql`
      INSERT INTO push_subscriptions (chain_id, endpoint, payer, p256dh, auth, created_at)
      VALUES (${this.scope.chainId}, ${subscription.endpoint}, ${payer}, ${subscription.p256dh}, ${subscription.auth}, ${nowSeconds})
      ON CONFLICT (chain_id, endpoint) DO UPDATE
        SET payer = EXCLUDED.payer, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, created_at = EXCLUDED.created_at`;
  }

  async deletePushSubscription(endpoint: string): Promise<void> {
    await this.sql`DELETE FROM push_subscriptions WHERE chain_id = ${this.scope.chainId} AND endpoint = ${endpoint}`;
  }

  async pushSubscriptionsFor(payer: Address): Promise<PushSubscriptionRecord[]> {
    return this.sql<PushSubscriptionRecord[]>`
      SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE chain_id = ${this.scope.chainId} AND payer = ${payer}`;
  }

  /**
   * Periodic mandates that will be charged within `windowSeconds` of `nowSeconds`, whose payer has
   * asked for reminders and has not been reminded of that charge. Only charges that will happen:
   * active, unpaused, before expiry, with room left under the lifetime cap.
   */
  async upcomingReminders(nowSeconds: number, windowSeconds: number): Promise<{ mandateId: bigint; payer: Address; chargeAt: number }[]> {
    const rows = await this.sql<{ id: string; payer: Address; next_charge_at: string }[]>`
      SELECT m.id, m.payer, m.next_charge_at FROM mandates m
      WHERE m.chain_id = ${this.scope.chainId} AND m.hub = ${this.scope.hub}
        AND m.status = 'Active' AND m.period > 0 AND m.paused_at = 0
        AND m.next_charge_at > ${nowSeconds} AND m.next_charge_at <= ${nowSeconds + windowSeconds}
        AND m.next_charge_at <= m.expires_at
        AND m.total_charged + m.amount <= m.max_total
        AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.chain_id = m.chain_id AND p.payer = m.payer)
        AND NOT EXISTS (
          SELECT 1 FROM push_sent s
          WHERE s.chain_id = m.chain_id AND s.hub = m.hub AND s.mandate_id = m.id AND s.kind = 'upcoming'
            AND s.key = m.next_charge_at::text
        )
      ORDER BY m.next_charge_at
      LIMIT 500`;
    return rows.map((row) => ({ mandateId: BigInt(row.id), payer: row.payer, chargeAt: Number(row.next_charge_at) }));
  }

  /** Charges that failed since `sinceSeconds`, whose payer has asked for reminders and not been told. */
  async failedReminders(sinceSeconds: number): Promise<{ mandateId: bigint; payer: Address; key: string; reason: number }[]> {
    const rows = await this.sql<{ mandate_id: string; payer: Address; tx_hash: string; log_index: number; reason: number | null }[]>`
      SELECT c.mandate_id, m.payer, c.tx_hash, c.log_index, c.reason
      FROM charges c
      JOIN mandates m ON m.chain_id = c.chain_id AND m.hub = c.hub AND m.id = c.mandate_id
      WHERE c.chain_id = ${this.scope.chainId} AND c.hub = ${this.scope.hub}
        AND c.kind = 'failed' AND c.block_time >= ${sinceSeconds}
        AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.chain_id = m.chain_id AND p.payer = m.payer)
        AND NOT EXISTS (
          SELECT 1 FROM push_sent s
          WHERE s.chain_id = c.chain_id AND s.hub = c.hub AND s.mandate_id = c.mandate_id AND s.kind = 'failed'
            AND s.key = c.tx_hash || ':' || c.log_index
        )
      ORDER BY c.block_number, c.log_index
      LIMIT 500`;
    return rows.map((row) => ({
      mandateId: BigInt(row.mandate_id),
      payer: row.payer,
      key: `${row.tx_hash}:${row.log_index}`,
      reason: Number(row.reason ?? 0),
    }));
  }

  /** Claims one reminder; false when it was already claimed, so each is sent at most once. */
  async claimReminder(mandateId: bigint, kind: "upcoming" | "failed", key: string, nowSeconds: number): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO push_sent (chain_id, hub, mandate_id, kind, key, sent_at)
      VALUES (${this.scope.chainId}, ${this.scope.hub}, ${mandateId.toString()}, ${kind}, ${key}, ${nowSeconds})
      ON CONFLICT DO NOTHING
      RETURNING 1`;
    return rows.length === 1;
  }

  /*//////////////////////////////////////////////////////////////
                           FAUCET, CURSOR
  //////////////////////////////////////////////////////////////*/

  async lastFaucetGrant(address: Address): Promise<number | undefined> {
    const [row] = await this.sql<{ granted_at: string }[]>`
      SELECT granted_at FROM faucet_grants
      WHERE chain_id = ${this.scope.chainId} AND address = ${address}
      ORDER BY granted_at DESC LIMIT 1`;
    return row === undefined ? undefined : Number(row.granted_at);
  }

  async recordFaucetGrant(address: Address, amount: bigint, tx: Hex, nowSeconds: number): Promise<void> {
    await this.sql`
      INSERT INTO faucet_grants (chain_id, address, amount, tx_hash, granted_at)
      VALUES (${this.scope.chainId}, ${address}, ${amount.toString()}, ${tx}, ${nowSeconds})`;
  }

  /** Every wallet a merchant has been paid to, current and past. */
  async merchantWallets(merchantId: string): Promise<Address[]> {
    const rows = await this.sql<{ address: Address }[]>`
      SELECT address FROM merchant_payouts WHERE merchant_id = ${merchantId} ORDER BY added_at`;
    return rows.map((row) => row.address);
  }

  /** The last block the indexer has written, or `undefined` before its first tick. */
  async indexedBlock(): Promise<number | undefined> {
    const [row] = await this.sql<{ last_block: string }[]>`
      SELECT last_block FROM indexer_cursors WHERE chain_id = ${this.scope.chainId} AND hub = ${this.scope.hub}`;
    return row === undefined ? undefined : Number(row.last_block);
  }
}
