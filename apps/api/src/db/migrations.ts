/**
 * The schema, as ordered migrations applied at startup.
 *
 * Each migration runs once, recorded in `schema_migrations`, and is also written to be harmless if
 * run again (`IF NOT EXISTS` throughout), so a half-applied history from an interrupted start is
 * finished rather than tripped over. Append new migrations; never edit a shipped one.
 *
 * Conventions:
 *
 * - Addresses are stored EIP-55 checksummed, as they arrive from validation and from viem, so
 *   comparisons are string equality.
 * - On-chain integers are `numeric(78,0)`, which holds any `uint256` exactly, and are read back as
 *   decimal strings, the wire format for amounts.
 * - Times are unix seconds in `bigint`, except the webhook schedule, which is milliseconds.
 * - Everything indexed is scoped by chain id and hub address, so a redeployed hub or a database
 *   pointed at another network never mixes its mandates with the old ones.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "merchants, plans, the index, webhooks, faucet",
    sql: `
CREATE TABLE IF NOT EXISTS merchants (
  id text PRIMARY KEY,
  auth_subject text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  payout_address text,
  webhook_url text,
  webhook_since bigint,
  webhook_secret text NOT NULL,
  webhook_secret_revealed boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL
);

-- Every address a merchant has been paid at. A merchant's mandates are the ones paying any of
-- them, so changing the payout address never hides the mandates that still pay the old one.
CREATE TABLE IF NOT EXISTS merchant_payouts (
  merchant_id text NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  address text NOT NULL,
  added_at bigint NOT NULL,
  PRIMARY KEY (merchant_id, address)
);
CREATE INDEX IF NOT EXISTS merchant_payouts_address ON merchant_payouts (address);

CREATE TABLE IF NOT EXISTS plans (
  id text PRIMARY KEY,
  chain_id integer NOT NULL,
  merchant_id text NOT NULL REFERENCES merchants (id),
  ref text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  asset text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('periodic', 'streaming')),
  amount numeric(78, 0) NOT NULL,
  period integer NOT NULL,
  trial_days integer NOT NULL,
  max_per_charge numeric(78, 0) NOT NULL,
  max_total numeric(78, 0) NOT NULL,
  term_seconds bigint NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS plans_chain_ref ON plans (chain_id, ref);
CREATE INDEX IF NOT EXISTS plans_merchant ON plans (merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS indexer_cursors (
  chain_id integer NOT NULL,
  hub text NOT NULL,
  last_block bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (chain_id, hub)
);

-- Every hub event the indexer has seen, keyed by where it sits in the chain.
CREATE TABLE IF NOT EXISTS hub_events (
  chain_id integer NOT NULL,
  hub text NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  block_time bigint NOT NULL,
  event text NOT NULL,
  mandate_id numeric(78, 0) NOT NULL,
  args jsonb NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS hub_events_block ON hub_events (chain_id, hub, block_number);
CREATE INDEX IF NOT EXISTS hub_events_mandate ON hub_events (chain_id, hub, mandate_id);

-- One row per mandate, refreshed from getMandate after its events, so it is the chain's state.
CREATE TABLE IF NOT EXISTS mandates (
  chain_id integer NOT NULL,
  hub text NOT NULL,
  id numeric(78, 0) NOT NULL,
  payer text NOT NULL,
  merchant text NOT NULL,
  asset text NOT NULL,
  vault text NOT NULL,
  manager text NOT NULL,
  amount numeric(78, 0) NOT NULL,
  period integer NOT NULL,
  next_charge_at numeric(20, 0) NOT NULL,
  max_per_charge numeric(78, 0) NOT NULL,
  max_total numeric(78, 0) NOT NULL,
  total_charged numeric(78, 0) NOT NULL DEFAULT 0,
  expires_at numeric(20, 0) NOT NULL,
  paused_at numeric(20, 0) NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('Active', 'Delinquent', 'Cancelled')),
  ref text NOT NULL,
  created_at bigint NOT NULL,
  created_block bigint NOT NULL,
  created_tx text NOT NULL,
  needs_refresh boolean NOT NULL DEFAULT true,
  refreshed_at bigint,
  PRIMARY KEY (chain_id, hub, id)
);
CREATE INDEX IF NOT EXISTS mandates_payer ON mandates (chain_id, hub, payer);
CREATE INDEX IF NOT EXISTS mandates_merchant ON mandates (chain_id, hub, merchant);
CREATE INDEX IF NOT EXISTS mandates_ref ON mandates (chain_id, ref);
CREATE INDEX IF NOT EXISTS mandates_refresh ON mandates (chain_id, hub) WHERE needs_refresh;

-- Charge attempts that reached the chain: Charged and ChargeFailed, one row per event.
CREATE TABLE IF NOT EXISTS charges (
  chain_id integer NOT NULL,
  hub text NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  block_time bigint NOT NULL,
  mandate_id numeric(78, 0) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('charged', 'failed')),
  amount numeric(78, 0) NOT NULL,
  reason smallint,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, tx_hash, log_index) REFERENCES hub_events (chain_id, tx_hash, log_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS charges_mandate ON charges (chain_id, hub, mandate_id, block_number DESC);
CREATE INDEX IF NOT EXISTS charges_time ON charges (chain_id, hub, block_time);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id bigserial PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_type text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_ms bigint NOT NULL,
  last_attempt_ms bigint,
  last_url text,
  last_status integer,
  last_error text,
  created_ms bigint NOT NULL,
  delivered_ms bigint,
  UNIQUE (merchant_id, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (next_attempt_ms) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS faucet_grants (
  id bigserial PRIMARY KEY,
  chain_id integer NOT NULL,
  address text NOT NULL,
  amount numeric(78, 0) NOT NULL,
  tx_hash text NOT NULL,
  granted_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS faucet_grants_address ON faucet_grants (chain_id, address, granted_at DESC);
`,
  },
  {
    version: 2,
    name: "family support circles and supporter names",
    sql: `
-- A circle is one recipient's; its contributions are mandates paying the recipient whose ref is
-- refFromString(id). The signature proves the recipient opened it, and makes a replay idempotent.
CREATE TABLE IF NOT EXISTS support_circles (
  id text PRIMARY KEY,
  chain_id integer NOT NULL,
  recipient text NOT NULL,
  ref text NOT NULL,
  name text NOT NULL,
  note text NOT NULL,
  asset text NOT NULL,
  period integer NOT NULL,
  goal numeric(78, 0) NOT NULL,
  signature text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (chain_id, signature)
);
CREATE INDEX IF NOT EXISTS support_circles_recipient ON support_circles (chain_id, recipient, created_at DESC);
CREATE INDEX IF NOT EXISTS support_circles_ref ON support_circles (chain_id, ref);

-- The name a supporter shows the recipient, one row per key that signed one. A name is shown
-- only when its signer is the mandate's payer or manager, checked when read, so a name can arrive
-- before the indexer has seen its mandate, and nobody else's row can replace it.
CREATE TABLE IF NOT EXISTS supporter_names (
  chain_id integer NOT NULL,
  hub text NOT NULL,
  mandate_id numeric(78, 0) NOT NULL,
  signer text NOT NULL,
  name text NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (chain_id, hub, mandate_id, signer)
);
`,
  },
  {
    version: 3,
    name: "push reminders",
    sql: `
-- A browser that asked for reminders for one payer. A device belongs to one payer at a time: a new
-- registration of the same endpoint moves it.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  chain_id integer NOT NULL,
  endpoint text NOT NULL,
  payer text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (chain_id, endpoint)
);
CREATE INDEX IF NOT EXISTS push_subscriptions_payer ON push_subscriptions (chain_id, payer);

-- One row per reminder decided on, written before it is sent, so each is sent at most once: the
-- day before a charge (key: the charge's time) and after a failed charge (key: the event).
CREATE TABLE IF NOT EXISTS push_sent (
  chain_id integer NOT NULL,
  hub text NOT NULL,
  mandate_id numeric(78, 0) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('upcoming', 'failed')),
  key text NOT NULL,
  sent_at bigint NOT NULL,
  PRIMARY KEY (chain_id, hub, mandate_id, kind, key)
);
`,
  },
  {
    version: 4,
    name: "a support circle's local currency",
    sql: `
-- The recipient's currency (ISO 4217), signed with the circle; "" for circles opened without one.
ALTER TABLE support_circles ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT '';
`,
  },
  {
    version: 5,
    name: "private notes",
    sql: `
-- A payer's private notes: one sealed blob per locker. The locker is a secret derived from the
-- payer's passkey, kept here only as its SHA-256, so the row names nobody and a copy of this table
-- cannot be used to overwrite one.
CREATE TABLE IF NOT EXISTS private_notes (
  chain_id integer NOT NULL,
  locker text NOT NULL,
  nonce text NOT NULL,
  ciphertext text NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (chain_id, locker)
);
`,
  },
];
