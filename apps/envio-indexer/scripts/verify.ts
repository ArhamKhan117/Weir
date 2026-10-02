/**
 * Checks what this indexer holds against the chain and against the Weir API.
 *
 *   pnpm verify [--api http://localhost:8790]... [--merchant 0x...]...
 *
 * Each network is compared with the API that serves it (asked by /health): the Testnet and the
 * Mainnet API locally (:8790, :8792) unless `--api` names others.
 *
 * 1. The chain. Every indexed mandate against `getMandate` at the block the indexer has reached,
 *    field for field, and `nextMandateId` against the count. Every event count against HyperSync's
 *    own count of the logs, and the charged volume against the sum of every `Charged` amount.
 * 2. The API's payer view. For every payer indexed, `GET /v1/payers/:address`: the same mandates,
 *    standings, totals and charges.
 * 3. The API's merchant overview, for each `--merchant` given: mandates, active and past-due
 *    counts, MRR and what was collected in the last thirty days, per asset. The overview signs in
 *    with the dev scheme, which creates a merchant account for an address it has not seen, so name
 *    only merchants that already have one.
 *
 * The two indexers follow the head on their own, so the API comparison first waits for this one to
 * reach the block the API reports, and runs again (up to three times) when a transaction lands in
 * between. Standings the API derives at the moment it answers; the indexer's are as of its last
 * sweep, so a mandate that expired in between is reported as waiting for the sweep.
 *
 * Exits 1 on any mismatch. Reads only: nothing is written anywhere.
 */

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { createPublicClient, http, toEventSelector, type Abi, type AbiEvent, type Address } from "viem";

import { standingOf, type Standing, type Status } from "../src/model.js";
import { NETWORKS } from "../src/networks.js";
import { indexerEnv, requireNode22 } from "./env.js";

requireNode22();
const { env, source, postgres: pg } = indexerEnv();

const argv = process.argv.slice(2);
const option = (name: string) => argv.flatMap((arg, i) => (arg === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));
const apiCandidates = option("api").length > 0 ? option("api") : [`http://localhost:${source.API_PORT ?? 8790}`, "http://localhost:8792"];

/** The API among the candidates that serves `chainId`, if one is running. */
async function apiFor(chainId: number): Promise<string | undefined> {
  for (const url of apiCandidates) {
    try {
      const health = (await (await fetch(`${url}/health`)).json()) as { chainId?: number };
      if (health.chainId === chainId) return url;
    } catch {
      // Not running.
    }
  }
  return undefined;
}
const merchants = option("merchant").map((address) => address.toLowerCase());

const hubAbi = JSON.parse(readFileSync(new URL("../abis/MandateHub.json", import.meta.url), "utf8")) as Abi;
const chargerAbi = JSON.parse(readFileSync(new URL("../abis/MandateCharger.json", import.meta.url), "utf8")) as Abi;
const STATUSES: readonly Status[] = ["Active", "Delinquent", "Cancelled"];
const API_STANDING: Record<string, Standing> = { "Past due": "PastDue" };

/** Check results for one section, printed together. */
class Section {
  readonly lines: string[] = [];
  failures = 0;

  check(ok: boolean, what: string, detail = ""): void {
    if (!ok) this.failures += 1;
    this.lines.push(`${ok ? "  ok  " : "  FAIL"} ${what}${detail === "" ? "" : `: ${detail}`}`);
  }

  same(what: string, ours: unknown, theirs: unknown): void {
    const ok = String(ours) === String(theirs);
    this.check(ok, what, ok ? String(ours) : `indexer ${String(ours)}, other ${String(theirs)}`);
  }

  note(line: string): void {
    this.lines.push(line);
  }
}

let failures = 0;
function print(title: string, section: Section): void {
  console.log(`\n${title}`);
  for (const line of section.lines) console.log(line);
  failures += section.failures;
}

interface MandateRow {
  mandateId: string;
  payer_id: string;
  merchant_id: string;
  asset: string;
  vault: string;
  manager: string;
  amount: string;
  period: number;
  nextChargeAt: string;
  maxPerCharge: string;
  maxTotal: string;
  totalCharged: string;
  expiresAt: string;
  pausedAt: string;
  status: Status;
  standing: Standing;
}

const sql = postgres({ ...pg, max: 2, onnotice: () => {} });

async function progressOf(chainId: number): Promise<number> {
  const [row] = await sql<{ progress_block: number }[]>`SELECT progress_block FROM envio_chains WHERE id = ${chainId}`;
  return row?.progress_block ?? 0;
}

const mandatesOf = (chainId: number) =>
  sql<MandateRow[]>`SELECT * FROM "Mandate" WHERE "chainId" = ${chainId} ORDER BY "mandateId"::numeric`;

/** 1. The chain, at exactly the block the index stands at. */
async function compareWithChain(chainId: number, block: number): Promise<void> {
  const network = NETWORKS[chainId]!;
  const mandates = await mandatesOf(chainId);
  const [counts] = await sql<
    { charges: string; volume: string | null; failures: string; reverts: string; reports: string; nonces: string; pauses: string; cancels: string }[]
  >`
    SELECT (SELECT count(*) FROM "Charge" WHERE "chainId" = ${chainId}) AS charges,
           (SELECT sum(amount) FROM "Charge" WHERE "chainId" = ${chainId}) AS volume,
           (SELECT count(*) FROM "ChargeFailure" WHERE "chainId" = ${chainId}) AS failures,
           (SELECT count(*) FROM "ChargeRevert" WHERE "chainId" = ${chainId}) AS reverts,
           (SELECT count(*) FROM "ChargerReport" WHERE "chainId" = ${chainId}) AS reports,
           (SELECT count(*) FROM "NonceInvalidation" WHERE "chainId" = ${chainId}) AS nonces,
           (SELECT coalesce(sum("pauseCount"), 0) FROM "Mandate" WHERE "chainId" = ${chainId}) AS pauses,
           (SELECT count(*) FROM "Mandate" WHERE "chainId" = ${chainId} AND "cancelledAt" IS NOT NULL) AS cancels`;
  const [networkRow] = await sql<{ volume: string; mandateCount: number }[]>`SELECT volume, "mandateCount" FROM "Network" WHERE id = ${`${chainId}`}`;

  const state = new Section();
  const client = createPublicClient({ transport: http(env[`ENVIO_RPC_URL_${chainId}`] ?? network.rpcUrl, { batch: true }) });
  const at = { blockNumber: BigInt(block) };
  const hub = network.hub as Address;
  const nextId = (await client.readContract({ address: hub, abi: hubAbi, functionName: "nextMandateId", ...at })) as bigint;
  state.same("mandates created (nextMandateId - 1)", mandates.length, nextId - 1n);
  state.same("Network.mandateCount", networkRow?.mandateCount, nextId - 1n);
  const onChain = (await Promise.all(
    mandates.map((m) => client.readContract({ address: hub, abi: hubAbi, functionName: "getMandate", args: [BigInt(m.mandateId)], ...at })),
  )) as Record<string, bigint | number | string>[];
  const fields = ["vault", "manager", "amount", "period", "nextChargeAt", "maxPerCharge", "maxTotal", "totalCharged", "expiresAt", "pausedAt"] as const;
  for (const [index, m] of mandates.entries()) {
    const chain = onChain[index]!;
    const differences: string[] = [];
    const compare = (name: string, ours: unknown, theirs: unknown) => {
      if (String(ours).toLowerCase() !== String(theirs).toLowerCase()) differences.push(`${name} ${String(ours)} vs ${String(theirs)}`);
    };
    compare("payer", m.payer_id.slice(`${chainId}-`.length), chain.payer);
    compare("merchant", m.merchant_id.slice(`${chainId}-`.length), chain.merchant);
    compare("asset", m.asset, chain.asset);
    for (const field of fields) compare(field, m[field], chain[field]);
    compare("status", m.status, STATUSES[Number(chain.status)]);
    state.check(differences.length === 0, `mandate ${m.mandateId}`, differences.length === 0 ? `${m.standing}, ${m.totalCharged} charged` : differences.join("; "));
  }
  print(`Against the chain: getMandate at block ${block}`, state);

  const logs = new Section();
  const hypersync = await countLogs(chainId, network.startBlock, block, [network.hub, network.charger]);
  const count = (name: string) => hypersync.counts[name] ?? 0;
  logs.same("MandateCreated", mandates.length, count("MandateCreated"));
  logs.same("Charged", counts?.charges, count("Charged"));
  logs.same("Charged volume", counts?.volume ?? 0, hypersync.chargedVolume);
  logs.same("Network.volume", networkRow?.volume, hypersync.chargedVolume);
  logs.same("ChargeFailed", counts?.failures, count("ChargeFailed"));
  logs.same("MandateCancelled", counts?.cancels, count("MandateCancelled"));
  logs.same("MandatePaused", counts?.pauses, count("MandatePaused"));
  logs.same("NonceInvalidated", counts?.nonces, count("NonceInvalidated"));
  logs.same("ReportCharged", counts?.reports, count("ReportCharged"));
  logs.same("ChargeReverted", counts?.reverts, count("ChargeReverted"));
  print(`Against HyperSync's own log counts, blocks ${network.startBlock} to ${block}`, logs);
}

async function apiHead(apiUrl: string): Promise<number | undefined> {
  const response = await fetch(`${apiUrl}/health`);
  const health = (await response.json()) as { indexer?: { indexedBlock?: number } };
  return health.indexer?.indexedBlock;
}

/** 2 and 3. The API's views, compared once both indexers have reached the same block. */
async function compareWithApi(chainId: number, apiUrl: string): Promise<{ payers: Section; merchants: Section; block: number }> {
  const target = (await apiHead(apiUrl)) ?? 0;
  for (let waited = 0; (await progressOf(chainId)) < target && waited < 60; waited += 1) await sleep(1_000);
  const block = await progressOf(chainId);
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const mandates = await mandatesOf(chainId);

  const payerSection = new Section();
  const payers = await sql<{ address: string; totalPaid: string; chargeCount: number }[]>`
    SELECT address, "totalPaid", "chargeCount" FROM "Payer" WHERE "chainId" = ${chainId} ORDER BY address`;
  for (const payer of payers) {
    const response = await fetch(`${apiUrl}/v1/payers/${payer.address}`);
    if (!response.ok) {
      payerSection.check(false, `payer ${payer.address}`, `API answered ${response.status}`);
      continue;
    }
    const view = (await response.json()) as {
      mandates: { id: string; standing: string; status: string; totalCharged: string }[];
      charges: { kind: string; amount: string }[];
    };
    const ours = mandates.filter((m) => m.payer_id === `${chainId}-${payer.address}`);
    const theirs = new Map(view.mandates.map((m) => [m.id, m]));
    const differences: string[] = [];
    if (ours.length !== view.mandates.length) differences.push(`${ours.length} mandates vs ${view.mandates.length}`);
    for (const m of ours) {
      const other = theirs.get(m.mandateId);
      if (other === undefined) {
        differences.push(`mandate ${m.mandateId} missing from the API`);
        continue;
      }
      const apiStanding = API_STANDING[other.standing] ?? (other.standing as Standing);
      if (m.standing !== apiStanding) {
        const now = standingOf(
          { ...m, pausedAt: BigInt(m.pausedAt), expiresAt: BigInt(m.expiresAt), totalCharged: BigInt(m.totalCharged), maxTotal: BigInt(m.maxTotal), amount: BigInt(m.amount) },
          nowSeconds,
        );
        differences.push(
          now === apiStanding
            ? `mandate ${m.mandateId} is ${m.standing} until the next sweep, ${apiStanding} now`
            : `mandate ${m.mandateId} ${m.standing} vs ${other.standing}`,
        );
      }
      if (m.status !== other.status) differences.push(`mandate ${m.mandateId} status ${m.status} vs ${other.status}`);
      if (m.totalCharged !== other.totalCharged) differences.push(`mandate ${m.mandateId} total ${m.totalCharged} vs ${other.totalCharged}`);
    }
    const charged = view.charges.filter((c) => c.kind === "charged");
    // The payer view lists at most 50 recent charges.
    if (view.charges.length < 50) {
      if (charged.length !== payer.chargeCount) differences.push(`${payer.chargeCount} charges vs ${charged.length}`);
      const paid = charged.reduce((sum, c) => sum + BigInt(c.amount), 0n);
      if (BigInt(payer.totalPaid) !== paid) differences.push(`paid ${payer.totalPaid} vs ${paid}`);
    }
    payerSection.check(
      differences.length === 0,
      `payer ${payer.address}`,
      differences.length === 0 ? `mandates ${ours.length}, charges ${payer.chargeCount}, paid ${payer.totalPaid}` : differences.join("; "),
    );
  }

  const merchantSection = new Section();
  for (const address of merchants) {
    const response = await fetch(`${apiUrl}/v1/merchant/overview`, { headers: { authorization: `Dev ${address}` } });
    if (!response.ok) {
      merchantSection.check(false, `merchant ${address}`, `API answered ${response.status}`);
      continue;
    }
    const overview = (await response.json()) as {
      mandates: unknown[];
      stats: { activeMandates: number; pastDue: number; mrr: Record<string, string>; collected30d: Record<string, string> };
    };
    const id = `${chainId}-${address}`;
    const [merchant] = await sql<{ mandateCount: number; activeMandates: number; pastDueMandates: number }[]>`
      SELECT "mandateCount", "activeMandates", "pastDueMandates" FROM "Merchant" WHERE id = ${id}`;
    const mrr = await sql<{ assetSymbol: string; value: string }[]>`
      SELECT "assetSymbol", mrr AS value FROM "MerchantAsset" WHERE merchant_id = ${id} AND mrr > 0 ORDER BY "assetSymbol"`;
    const collected = await sql<{ assetSymbol: string; value: string }[]>`
      SELECT "assetSymbol", sum(amount) AS value FROM "Charge"
      WHERE merchant_id = ${id} AND timestamp >= ${(nowSeconds - 2_592_000n).toString()}
      GROUP BY "assetSymbol" ORDER BY "assetSymbol"`;
    const record = (rows: { assetSymbol: string; value: string }[]) => JSON.stringify(Object.fromEntries(rows.map((r) => [r.assetSymbol, r.value])));
    const sorted = (value: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
    merchantSection.note(`  merchant ${address}`);
    merchantSection.same("  mandates", merchant?.mandateCount ?? 0, overview.mandates.length);
    merchantSection.same("  active", merchant?.activeMandates ?? 0, overview.stats.activeMandates);
    merchantSection.same("  past due", merchant?.pastDueMandates ?? 0, overview.stats.pastDue);
    merchantSection.same("  MRR", record(mrr), sorted(overview.stats.mrr));
    merchantSection.same("  collected, 30 days", record(collected), sorted(overview.stats.collected30d));
  }
  return { payers: payerSection, merchants: merchantSection, block };
}

try {
  const chains = await sql<{ id: number }[]>`SELECT id FROM envio_chains ORDER BY id`;
  for (const { id: chainId } of chains) {
    const network = NETWORKS[chainId];
    if (network === undefined) throw new Error(`chain ${chainId} is indexed but not in src/networks.ts`);
    const block = await progressOf(chainId);
    console.log(`${network.name} (${chainId}), hub ${network.hub}, indexed to block ${block}`);
    await compareWithChain(chainId, block);

    const apiUrl = await apiFor(chainId);
    if (apiUrl === undefined) {
      console.log(`\nNo API serving chain ${chainId} is running (tried ${apiCandidates.join(", ")}); skipping the API comparison`);
      continue;
    }
    let api = await compareWithApi(chainId, apiUrl);
    for (let attempt = 2; attempt <= 3 && api.payers.failures + api.merchants.failures > 0; attempt += 1) {
      console.log(`\n(the API view moved while it was read; comparing again, attempt ${attempt})`);
      await sleep(3_000);
      api = await compareWithApi(chainId, apiUrl);
    }
    print(`Against the API's payer view (${apiUrl}), indexer at block ${api.block}`, api.payers);
    if (merchants.length > 0) print("Against the API's merchant overview", api.merchants);
  }
} finally {
  await sql.end();
}

console.log(failures === 0 ? "\nverify: everything agrees" : `\nverify: ${failures} mismatch(es)`);
process.exit(failures === 0 ? 0 : 1);

/** Per-event log counts from HyperSync over `[fromBlock, toBlock]`, and the sum of `Charged` amounts. */
async function countLogs(chainId: number, fromBlock: number, toBlock: number, addresses: string[]) {
  const token = env.ENVIO_API_TOKEN;
  if (token === undefined) throw new Error("No HyperSync token (HYPERSYNC_API_TOKEN or ENVIO_API_TOKEN)");
  const url = chainId === 143 ? "https://monad.hypersync.xyz" : "https://monad-testnet.hypersync.xyz";
  const names = new Map<string, string>();
  for (const abi of [hubAbi, chargerAbi]) {
    for (const item of abi) if (item.type === "event") names.set(toEventSelector(item as AbiEvent), item.name);
  }
  const chargedTopic = [...names].find(([, name]) => name === "Charged")?.[0];

  const counts: Record<string, number> = {};
  let chargedVolume = 0n;
  let from = fromBlock;
  while (from <= toBlock) {
    const query = JSON.stringify({ from_block: from, to_block: toBlock + 1, logs: [{ address: addresses }], field_selection: { log: ["topic0", "data"] } });
    let response: Response;
    // HyperSync rate-limits a token the indexer and the API share: wait and ask again.
    for (let attempt = 0; ; attempt += 1) {
      response = await fetch(`${url}/query`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: query,
      });
      if ((response.status !== 429 && response.status < 500) || attempt >= 8) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** attempt)));
    }
    if (!response.ok) throw new Error(`HyperSync answered ${response.status}`);
    const body = (await response.json()) as { data?: { logs?: { topic0: string; data: string }[] }[]; next_block: number };
    for (const batch of body.data ?? []) {
      for (const log of batch.logs ?? []) {
        const name = names.get(log.topic0) ?? log.topic0;
        counts[name] = (counts[name] ?? 0) + 1;
        // `Charged` data is (amount, totalCharged, nextChargeAt): the amount is the first word.
        if (log.topic0 === chargedTopic) chargedVolume += BigInt(`0x${log.data.slice(2, 66)}`);
      }
    }
    if (body.next_block <= from) break;
    from = body.next_block;
  }
  return { counts, chargedVolume };
}
