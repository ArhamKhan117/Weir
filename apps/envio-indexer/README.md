# Weir on Envio HyperIndex

A GraphQL API over Weir: every mandate and where it stands, every charge and who sent it, Chainlink CRE reports, and each merchant's revenue, MRR and customers, on Monad.
It is an [Envio HyperIndex](https://docs.envio.dev) project that reads `MandateHub` and `MandateCharger` through HyperSync.

It keeps the same figures as the Weir API's own index, by the same rules, so a merchant dashboard or a payer's page can be built on it alone.
`pnpm verify` checks that claim against the chain and against a running API.

## What it indexes

| Entity | One row per | What it carries |
| --- | --- | --- |
| `Mandate` | mandate | Every term, status, standing, `totalCharged`, `remaining`, `chargeCount`, the last failure and its reason, MRR and monthly commitment, created and cancelled times, blocks and transactions |
| `Charge` | `Charged` | Amount, the mandate's new total and schedule, who sent it (`trigger`), the CRE report it belonged to, block, time, transaction |
| `ChargeFailure` | `ChargeFailed` | Reason (`InsufficientBalance`, `InsufficientAllowance`, `TransferRefused`) and code, amount required, trigger |
| `ChargeRevert` | `ChargeReverted` from a batch | The revert selector and the error it names, such as `NotDue(uint64,uint256)` |
| `ChargerReport` | `ReportCharged` | Workflow id, forwarder, whether the CRE simulator sent it, attempted, charged, failed, reverted, volume, and links to its charges |
| `MandateEvent` | hub event, and each expiry | A mandate's timeline: created, charged, failed, paused, resumed, cancelled, manager changed, expired |
| `NonceInvalidation` | `NonceInvalidated` | The signer and the nonce it voided |
| `Payer`, `PayerAsset` | payer, and payer per asset | Mandates by standing, committed each month, paid in total, charges, failures |
| `Merchant`, `MerchantAsset` | merchant, and merchant per asset | Mandates by standing, MRR, revenue, charges, failures, customers and active customers |
| `MerchantCustomer` | merchant and payer | Mandates, live mandates, paid in total, last charge |
| `DailyStat`, `MerchantDailyStat` | UTC day, network-wide and per merchant | Volume, charges, failures, new mandates, cancellations, expirations, reports, and active mandates and MRR at the day's last change |
| `Network` | chain | Every count and total across the network, and `standingAsOf` |

Ids carry the chain, so the index can hold Testnet and Mainnet at once: `10143-7` is mandate 7 on Testnet, `10143-0xabc...` an account.
Every address is lowercase, so a filter never needs case folding.
Amounts are base units as `BigInt`; every asset the hub accepts is a six-decimal dollar, so sums across assets are dollars.

## How the figures are kept

**Standing** follows `standingOf` in `packages/shared/src/types.ts`: cancelled, then expired, then completed (the lifetime cap cannot take another charge), then paused, then past due, then active.
The API's "Past due" is `PastDue` here, because a GraphQL enum value cannot contain a space.
`test/model.test.ts` holds this copy to the original over every combination that can tell them apart.

**Expiry** is the one standing no event announces.
A block handler (`src/handlers/Sweep.ts`) finds open mandates past their `expiresAt` about once a minute at the head and restates them, which takes them out of MRR, commitments and active counts.
It needs the time of a block, which HyperSync does not hand a block handler, so it asks an RPC once per pass (cached, and skipped while nothing is open).
While the indexer catches up it runs about once an hour of blocks, and it dates each expiry to its own day either way.
`Network.standingAsOf` says when standings were last evaluated; a mandate whose `expiresAt` has passed is expired whatever its row says.

**MRR** is `MerchantAsset.mrr`: for each `Active` periodic mandate, `amount * 30 days / period`, rounded down, exactly as the API's merchant overview.
**Committed each month** is `Payer.committedMonthly`: the same for periodic mandates that are active or past due, as the payments page shows it.
**Collected in the last 30 days** is a rolling window, so it is not stored: sum `Charge.amount` where `timestamp` is within it (a query below does), or chart `MerchantDailyStat`.

**Who sent a charge** is `trigger`:

- `Cre` when `ReportCharged` follows in the same transaction. A report's charges run inside `onReport`, before the event, so the report finds them by transaction hash, links them to itself and counts what they came to.
- `Keeper` when the transaction went to `MandateCharger.chargeMany`.
- `Direct` when it called `MandateHub.charge` itself.
- `Settlement` when a stream collected what it had accrued as it was paused or cancelled: that charge is the log right before the `MandatePaused` or `MandateCancelled`.

Every mandate field is rebuilt from events alone (the checkpoint shift on resume included), so a full sync runs at HyperSync's speed and `pnpm verify` finds every mandate equal to `getMandate`, field for field.
Every aggregate is kept by one function, `restate` in `src/books.ts`, that carries a standing change into every count, MRR and commitment at once; the handler tests check each aggregate against the mandates it sums.

## What reads it

The Weir app's features read this index, through the API, which queries its database read only (`ENVIO_DATABASE_URL`, `apps/api/src/analytics/envio.ts`):

- **The business dashboard's Revenue section** (`GET /v1/merchant/analytics`): the last 30 days of `MerchantDailyStat` per day, all-time `revenue`, `mrr`, `customers` and `activeCustomers` from `Merchant`, summed across every wallet the business is paid to, and the split of its charges by `Charge.trigger`, so a business sees which ones the Chainlink CRE workflow sent.
- **The home page's live figures** (`GET /v1/stats`): each `Network`'s mandates, volume, charges and CRE reports, and 30 days of `DailyStat`.

Run locally, the indexer follows both networks and a charge shows on the dashboard a few seconds after it lands; `pnpm verify` checks the figures against the chain and the API.

## Run it locally

No Docker is needed: the indexer runs against the Postgres already on the machine, in a database of its own (`weir_envio`), without Hasura.
It needs Node 22 or later and the repository's `.env` with `HYPERSYNC_API_TOKEN` and `DATABASE_URL`.
`scripts/env.ts` maps those onto what Envio reads (`ENVIO_API_TOKEN`, `ENVIO_PG_*`, `ENVIO_HASURA=false`) and never prints them.

This directory is outside the pnpm workspace, so install it on its own:

```bash
cd apps/envio-indexer
pnpm install --ignore-workspace
pnpm local                 # envio start: sync to the head, then follow it
pnpm local start -r        # drop the index and sync again from the start block
pnpm verify --merchant 0x1e58Ae7a5bFb164ff071Dd5e71a1061A0E9097a1
```

`pnpm local` creates `weir_envio` on first run and refuses to use the API's database.
Stop it with Ctrl-C; the next start resumes where it stopped.
The indexer serves `/healthz` and Prometheus `/metrics` on port 9898 (`ENVIO_INDEXER_PORT`).

A full Testnet sync takes a few seconds: the hub's whole history is a few thousand blocks and a few dozen events.

### Verify

`pnpm verify` compares the index with three sources and exits 1 on any difference:

1. The chain: every mandate against `getMandate` at the indexed block, and `nextMandateId`.
2. HyperSync's own count of every event, and the sum of every `Charged` amount.
3. The API: `GET /v1/payers/:address` for every payer, and `GET /v1/merchant/overview` for each `--merchant` (mandates, active, past due, MRR and collected in 30 days, per asset).

The overview signs in with the dev scheme (`WEIR_DEV_AUTH=1`), which creates a merchant account for an address the API has not seen, so pass only merchants that already have one.
Both indexers follow the head on their own; the script waits for this one to reach the block the API reports, and compares again when a transaction lands in between.

## After the hub is redeployed

Addresses, start blocks, CRE forwarders, asset symbols and ABIs all come from the repository's own records, through one script:

```bash
pnpm sync                  # from packages/shared/src/deployments.json and packages/shared/src/abi.ts
pnpm local start -r        # a new hub is a new history: index it from its start block
```

`pnpm sync` writes `config.yaml`, `abis/` and `src/networks.ts`, which are committed because the hosted service builds from this directory alone.
`pnpm sync:check` fails when any of them is out of date.
Every network in `deployments.json` becomes a chain in `config.yaml`, so the one index holds Mainnet and Testnet together.
The sync also fails when a contract gains an event nobody has decided how to index.

## Tests

```bash
pnpm test         # codegen, then vitest
pnpm typecheck    # codegen, then tsc
```

`test/handlers.test.ts` runs the real config, schema and handlers in Envio's test indexer on simulated events, with no network: a periodic mandate through a keeper charge, a failure, a direct charge and its cap; a stream's settlement on pause and its checkpoint on resume; a CRE report with a charge, a failure and a revert; an expiry found by the sweep; a cancellation.
After each, every aggregate is checked against the mandates it sums.
`test/model.test.ts` holds the standing and MRR rules to the shared and API originals when they are present.

## Query it

On the hosted service the entities are served as GraphQL, one query field per entity, filtered with `where`, sorted with `order_by`, and fetched by id with `<Entity>_by_pk`.
`BigInt` fields are `numeric` there.
Aggregate queries are not exposed on the hosted service, which is why the counts and totals are kept on the entities.

A merchant's dashboard, with its figures per asset and the last 30 days for a chart:

```graphql
query MerchantDashboard($merchant: String!) {
  Merchant(where: { address: { _eq: $merchant } }) {
    mrr
    revenue
    activeMandates
    pastDueMandates
    customers
    activeCustomers
    assets { assetSymbol mrr revenue activeMandates pastDueMandates }
    days(order_by: { dayStart: desc }, limit: 30) { date volume charges failures newMandates cancellations }
  }
}
```

A payer's mandates, each with its last charges and who sent them:

```graphql
query PayerMandates($payer: String!) {
  Mandate(where: { payer: { address: { _eq: $payer } } }, order_by: { mandateId: desc }) {
    mandateId
    assetSymbol
    mode
    amount
    period
    standing
    totalCharged
    remaining
    nextChargeAt
    expiresAt
    merchant { address }
    charges(order_by: { timestamp: desc }, limit: 5) { amount trigger timestamp transactionHash }
  }
}
```

What a merchant collected in the last 30 days, per asset, the figure the API's overview shows:

```graphql
query Collected($merchant: String!, $since: numeric!) {
  Charge(where: { merchant: { address: { _eq: $merchant } }, timestamp: { _gte: $since } }) {
    assetSymbol
    amount
  }
}
```

Every CRE report, with what it charged:

```graphql
query Reports {
  ChargerReport(order_by: { timestamp: desc }) {
    workflowId
    simulated
    attempted
    charged
    failed
    reverted
    volume
    charges { amount mandate { mandateId } }
    reverts { mandateId error }
  }
}
```

Past-due mandates across the network, and how far each is behind:

```graphql
query PastDue {
  Mandate(where: { standing: { _eq: "PastDue" } }) {
    mandateId
    lastFailureReason
    lastFailureAmount
    lastFailureAt
    payer { address }
    merchant { address }
  }
}
```

Whether the index has reached the head, per chain:

```graphql
{ _meta { chainId progressBlock sourceBlock isReady } }
```

Locally there is no GraphQL server, since Hasura runs only as a container, but the same data is in `weir_envio`, one table per entity with the field names quoted:

```sql
SELECT address, mrr, revenue, "activeMandates", "pastDueMandates", customers, "activeCustomers" FROM "Merchant";
SELECT "mandateId", standing, "totalCharged", remaining, mrr FROM "Mandate" ORDER BY "mandateId";
SELECT mandate_id, amount, trigger, report_id FROM "Charge" ORDER BY "blockNumber", "logIndex";
SELECT "assetSymbol", sum(amount) FROM "Charge"
  WHERE merchant_id = '10143-0x1e58ae7a5bfb164ff071dd5e71a1061a0e9097a1'
    AND timestamp >= extract(epoch FROM now()) - 2592000
  GROUP BY "assetSymbol";
```

## Deploy to Envio Cloud

The hosted service builds from a GitHub repository and uploads only the indexer's directory.
Everything it needs is committed here: `package.json` with `envio` pinned exactly, `config.yaml`, `schema.graphql`, `abis/` and `src/`.
Nothing the indexer runs reads outside this directory, and it needs no HyperSync token there.

1. Push the repository to GitHub, with this directory committed and `pnpm sync:check` passing.
2. Sign in at [envio.dev/app](https://envio.dev/app/login) with GitHub, choose the organisation, and install the Envio Deployments GitHub App on the repository.
3. Add an indexer on the repository with these settings:
   - Indexer directory: `apps/envio-indexer`
   - Config file: `config.yaml`
   - Deployment branch: a branch of its own, for example `envio`
4. Optionally, under Environment Variables, set `ENVIO_RPC_URL_143` and `ENVIO_RPC_URL_10143` to RPCs of your choice; the public Monad RPCs are used otherwise, for block times and as the fallback source.
5. Push the deployment branch: `git push origin HEAD:envio`. Each push builds a new deployment and syncs it from the start block while the previous one keeps serving.
6. When it is synced, promote it to production, and query `https://<your endpoint>/v1/graphql`.

The free development plan deletes a deployment after 30 days and starts winding one down past 100,000 processed events; each sweep pass counts as one, about 1,500 a day on Testnet.
The same steps work with the alpha `envio-cloud` CLI: `envio-cloud indexer add --name weir --repo <repo> --root-dir apps/envio-indexer --branch envio`.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `ENVIO_API_TOKEN` | self-hosted | HyperSync access; `pnpm local` sets it from `HYPERSYNC_API_TOKEN`. Not needed on Envio Cloud. |
| `ENVIO_PG_HOST`, `ENVIO_PG_PORT`, `ENVIO_PG_USER`, `ENVIO_PG_PASSWORD`, `ENVIO_PG_DATABASE` | self-hosted | The indexer's Postgres; `pnpm local` derives them from `DATABASE_URL`, database `weir_envio`. |
| `ENVIO_HASURA` | self-hosted | `false` without Hasura; `pnpm local` sets it. |
| `ENVIO_RPC_URL_<chainId>` | anywhere | The RPC for block times and the fallback source; `pnpm local` sets it from `MONAD_RPC_URL`. Envio may log it, so use a URL with no key in it. |

## Layout

| Path | What it is |
| --- | --- |
| `config.yaml`, `abis/`, `src/networks.ts` | Generated by `scripts/sync.ts` from the deployment record and the ABIs; committed |
| `schema.graphql` | The entities above |
| `src/model.ts` | The rules, as pure functions: standing, MRR, commitment, resume, failure reasons, triggers, days |
| `src/books.ts` | The aggregates one mandate feeds, opened, restated and closed together |
| `src/handlers/MandateHub.ts` | Mandates, charges, failures, pauses, cancellations, managers, nonces |
| `src/handlers/MandateCharger.ts` | CRE reports and batch reverts |
| `src/handlers/Sweep.ts`, `src/clock.ts` | The expiry sweep and the block time it needs |
| `scripts/local.ts`, `scripts/env.ts` | Running it locally without Docker |
| `scripts/verify.ts` | The comparison with the chain, HyperSync and the API |
| `test/` | The handler and model tests |
