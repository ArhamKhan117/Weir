/**
 * Weir on Monad Mainnet with real money, end to end, through the real services.
 *
 * It starts the API (relayer and indexer) and the keeper against Mainnet with `.env.mainnet`, then
 * drives them the way the web app does, as a payer that never holds MON:
 *
 *   1. saves $0.50 of USDC into the Morpho USDC vault through the savings router,
 *   2. installs three monthly $0.10 mandates: one on the balance, one on savings, and one on savings
 *      that starts a couple of minutes later,
 *   3. waits for the keeper to charge the first two (the second from the real Morpho vault),
 *   4. takes the savings back out, so the keeper must charge the third from the balance instead,
 *   5. streams $0.0001 a second from the balance and pauses it with the session key alone,
 *   6. cancels every mandate, and returns whatever the payer has left.
 *
 * Every check is made on chain, and the indexed view is checked against it. The payer's keys live
 * in `.state/mainnet-live/payer.json` (gitignored, never printed). The first run prints the payer's
 * address and stops: send it at least $1.00 of USDC on Monad Mainnet, then run it again. About
 * $0.31 goes to the merchant (the deployer, unless `LIVE_MERCHANT` names another address) and the
 * rest returns to the deployer (or `LIVE_RETURN_TO`). The relayer and the keeper pay the gas.
 *
 *   pnpm live:mainnet
 *
 * It writes `.state/mainnet-live/report.json`, plus the API's and the keeper's logs beside it.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import {
  createWalletClient,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseEventLogs,
  parseSignature,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  actionTypedData,
  createMandateTypedData,
  createMonadClient,
  explorerUrl,
  formatDollarsExact,
  hubDomain,
  loadNetworkConfig,
  MAINNET_USDC,
  mandateHubAbi,
  mandateStatusFromIndex,
  networkFor,
  permitTypedData,
  randomNonce,
  refFromString,
  requireDeployment,
  requireSecret,
  stablecoinAbi,
  type InstallResponse,
  type MandateTerms,
  type PayerResponse,
  type RelayResponse,
} from "../packages/shared/src/index.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATE = `${ROOT}.state/mainnet-live/`;
const MAINNET = 143;

const network = loadNetworkConfig();
if (network.chainId !== MAINNET) throw new Error("This run is for Mainnet: run it with .env.mainnet (pnpm live:mainnet)");
const deployment = requireDeployment(MAINNET);
const chain = networkFor(MAINNET).chain;
const publicClient = createMonadClient(network);

const hub = deployment.contracts.MandateHub;
const charger = deployment.contracts.MandateCharger;
const router = getAddress(deployment.contracts.SavingsRouter ?? "");
const usdc = getAddress(deployment.assets["USDC"] ?? "");
const vault = getAddress(deployment.savings?.["USDC"] ?? "");
const domain = hubDomain({ name: deployment.eip712.name, chainId: MAINNET, address: hub });

const deployer = privateKeyToAccount(requireSecret("DEPLOYER_PRIVATE_KEY").reveal() as Hex);
const relayerAddress = privateKeyToAccount(requireSecret("RELAYER_PRIVATE_KEY").reveal() as Hex).address;
const keeperAddress = privateKeyToAccount(requireSecret("KEEPER_PRIVATE_KEY").reveal() as Hex).address;

const optionalAddress = (name: string): Address | undefined => {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") return undefined;
  if (!isAddress(value)) throw new Error(`${name} is not an address`);
  return getAddress(value);
};
const merchant = optionalAddress("LIVE_MERCHANT") ?? deployer.address;
const returnTo = optionalAddress("LIVE_RETURN_TO") ?? deployer.address;

const CENT = 10_000n;
const DOLLAR = 100n * CENT;
const NEEDED = DOLLAR;
const SAVED = 50n * CENT;
const MONTHLY = 10n * CENT;
const MONTH = 2_592_000;
const STREAM_RATE = 100n;
const STREAM_CAP = 5n * CENT;
const THIRD_STARTS_IN = 150;

const vaultAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
]);

/*//////////////////////////////////////////////////////////////
                             THE PAYER
//////////////////////////////////////////////////////////////*/

mkdirSync(STATE, { recursive: true });
const keysFile = `${STATE}payer.json`;
if (!existsSync(keysFile)) {
  writeFileSync(keysFile, JSON.stringify({ payer: generatePrivateKey(), session: generatePrivateKey() }), { mode: 0o600 });
  chmodSync(keysFile, 0o600);
}
const keys = JSON.parse(readFileSync(keysFile, "utf8")) as { payer: Hex; session: Hex };
const payer = privateKeyToAccount(keys.payer);
const session = privateKeyToAccount(keys.session);

/*//////////////////////////////////////////////////////////////
                              REPORT
//////////////////////////////////////////////////////////////*/

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const report = {
  startedAt: new Date().toISOString(),
  chainId: MAINNET,
  contracts: { hub, charger, router, usdc, vault },
  payer: payer.address,
  session: session.address,
  merchant,
  returnTo,
  mandates: {} as Record<string, string>,
  transactions: [] as { label: string; hash: Hex; url: string }[],
  checks: [] as Check[],
  finishedAt: "",
  passed: false,
};
const writeReport = () => writeFileSync(`${STATE}report.json`, `${JSON.stringify(report, null, 2)}\n`);

function tx(label: string, hash: Hex): void {
  const url = explorerUrl(MAINNET, "tx", hash);
  report.transactions.push({ label, hash, url });
  console.log(`  ${label.padEnd(40)} ${url}`);
}

function check(name: string, ok: boolean, detail: string): void {
  report.checks.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  writeReport();
}

const dollars = formatDollarsExact;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = async () => Number((await publicClient.getBlock()).timestamp);
const usdcOf = (who: Address) => publicClient.readContract({ address: usdc, abi: stablecoinAbi, functionName: "balanceOf", args: [who] });
const sharesOf = (who: Address) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [who] });
const mandateOf = (id: bigint) => publicClient.readContract({ address: hub, abi: mandateHubAbi, functionName: "getMandate", args: [id] });

/*//////////////////////////////////////////////////////////////
                         FUNDING PREFLIGHT
//////////////////////////////////////////////////////////////*/

console.log("Weir live run on Monad Mainnet");
console.log(`  hub ${hub}, charger ${charger}, router ${router}`);
console.log(`  payer ${payer.address} (holds no MON), merchant ${merchant}`);

const [payerUsdc, relayerMon, keeperMon] = await Promise.all([
  usdcOf(payer.address),
  publicClient.getBalance({ address: relayerAddress }),
  publicClient.getBalance({ address: keeperAddress }),
]);
const MIN_MON = 10n ** 17n;
if (relayerMon < MIN_MON || keeperMon < MIN_MON) {
  console.log(`\nThe relayer (${relayerAddress}) and the keeper (${keeperAddress}) each need at least 0.1 MON for gas.`);
  process.exit(2);
}
if (payerUsdc < NEEDED) {
  console.log(`\nThe payer holds ${dollars(payerUsdc)} of USDC and needs ${dollars(NEEDED)}.`);
  console.log(`Send at least ${dollars(NEEDED - payerUsdc)} of USDC (${usdc}) on Monad Mainnet to:\n\n  ${payer.address}\n`);
  console.log("Then run `pnpm live:mainnet` again. Send USDC only: the payer never needs MON.");
  process.exit(2);
}

/*//////////////////////////////////////////////////////////////
                      THE API AND THE KEEPER
//////////////////////////////////////////////////////////////*/

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// A Mainnet API already running would index into the same database as the one started here.
const runningPort = process.env.API_PORT ?? "8792";
const running = await fetch(`http://127.0.0.1:${runningPort}/health`).then(() => true, () => false);
if (running) {
  console.log(`\nA Weir API is already running on :${runningPort}. Stop \`pnpm api:mainnet\` (and \`pnpm keeper:mainnet\`) first: this run starts its own.`);
  process.exit(2);
}

// The API keeps its index in DATABASE_URL's database; Postgres needs it to exist first.
const database = new URL(requireSecret("DATABASE_URL").reveal()).pathname.replace(/^\//, "");
spawnSync("createdb", [database], { stdio: "ignore", env: process.env });

const [apiPort, keeperPort] = await Promise.all([freePort(), freePort()]);
const children: ChildProcess[] = [];
function start(name: string, args: string[], cwd: string, env: Record<string, string>): void {
  const log = createWriteStream(`${STATE}${name}.log`);
  const child = spawn("pnpm", ["exec", "tsx", ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push(child);
}
function stopAll(): void {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
process.on("exit", stopAll);
process.on("SIGINT", () => process.exit(130));

start("api", ["--tsconfig", "tsconfig.json", "src/main.ts"], `${ROOT}apps/api`, { API_PORT: String(apiPort) });
start("keeper", ["apps/keeper/src/index.ts"], ROOT, { KEEPER_PORT: String(keeperPort), KEEPER_INTERVAL_MS: "4000" });
const base = `http://127.0.0.1:${apiPort}`;

async function waitFor(label: string, url: string, seconds: number): Promise<void> {
  for (let waited = 0; waited < seconds; waited += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(1_000);
  }
  throw new Error(`${label} did not come up in ${seconds}s; see ${STATE}${label}.log`);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const parsed = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(`POST ${path} answered ${response.status}: ${parsed.error?.message ?? JSON.stringify(parsed)}`);
  return parsed;
}

/*//////////////////////////////////////////////////////////////
                          SIGNING HELPERS
//////////////////////////////////////////////////////////////*/

async function permit(token: Address, permitDomain: { name?: string; version?: string }, spender: Address, value: bigint, deadline: number): Promise<Hex> {
  const nonce = await publicClient.readContract({ address: token, abi: vaultAbi, functionName: "nonces", args: [payer.address] });
  return payer.signTypedData(permitTypedData({ token: { address: token, permit: permitDomain }, chainId: MAINNET, owner: payer.address, spender, value, nonce, deadline: BigInt(deadline) }));
}

async function terms(overrides: Partial<MandateTerms>): Promise<MandateTerms> {
  return {
    merchant,
    asset: usdc,
    vault: zeroAddress,
    manager: session.address,
    amount: MONTHLY,
    period: MONTH,
    startAt: 0n,
    maxPerCharge: MONTHLY,
    maxTotal: 3n * MONTHLY,
    expiresAt: BigInt((await now()) + 365 * 86_400),
    ref: refFromString("weir-live"),
    ...overrides,
  };
}

/** Installs through the relayer: the permit on what it draws, the backup when from savings, the terms. */
async function install(label: string, t: MandateTerms): Promise<bigint> {
  const deadline = (await now()) + 600;
  const fromSavings = t.vault !== zeroAddress;
  const [shares, allowed] = await Promise.all([
    fromSavings ? publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "previewWithdraw", args: [t.maxTotal] }) : Promise.resolve(t.maxTotal),
    publicClient.readContract({ address: usdc, abi: stablecoinAbi, functionName: "allowance", args: [payer.address, hub] }),
  ]);
  // One allowance on USDC serves every mandate drawing on it, so each permit adds this cap to it.
  const usdcValue = allowed + t.maxTotal;
  const permitBody = fromSavings
    ? { token: vault, owner: payer.address, value: shares.toString(), deadline, signature: await permit(vault, {}, hub, shares, deadline) }
    : { token: usdc, owner: payer.address, value: usdcValue.toString(), deadline, signature: await permit(usdc, MAINNET_USDC.permit, hub, usdcValue, deadline) };
  const backupPermit = fromSavings
    ? { token: usdc, owner: payer.address, value: usdcValue.toString(), deadline, signature: await permit(usdc, MAINNET_USDC.permit, hub, usdcValue, deadline) }
    : undefined;
  const nonce = randomNonce();
  const response = await post<InstallResponse>("/v1/relay/install", {
    permit: permitBody,
    ...(backupPermit === undefined ? {} : { backupPermit }),
    payer: payer.address,
    terms: {
      ...t,
      amount: t.amount.toString(),
      startAt: Number(t.startAt),
      maxPerCharge: t.maxPerCharge.toString(),
      maxTotal: t.maxTotal.toString(),
      expiresAt: Number(t.expiresAt),
    },
    nonce: nonce.toString(),
    deadline,
    signature: await payer.signTypedData(createMandateTypedData({ domain, payer: payer.address, terms: t, nonce, deadline: BigInt(deadline) })),
  });
  tx(`install ${label} (mandate ${response.mandateId})`, response.transactions.create);
  report.mandates[label] = response.mandateId;
  return BigInt(response.mandateId);
}

async function act(id: bigint, action: "pause" | "cancel", signer: typeof payer): Promise<void> {
  const nonce = randomNonce();
  const deadline = (await now()) + 600;
  const signature = await signer.signTypedData(actionTypedData({ domain, mandateId: id, action, nonce, deadline: BigInt(deadline) }));
  const response = await post<RelayResponse>("/v1/relay/action", {
    mandateId: id.toString(),
    action,
    signer: signer.address,
    nonce: nonce.toString(),
    deadline,
    signature,
  });
  tx(`${action} mandate ${id}${signer === session ? " (session key)" : ""}`, response.transaction);
}

/** Waits until the keeper has charged `id` past `before`, and returns the hub events of that charge. */
async function chargedByKeeper(id: bigint, before: bigint, seconds: number) {
  for (let waited = 0; waited < seconds; waited += 2) {
    if ((await mandateOf(id)).totalCharged > before) break;
    await sleep(2_000);
  }
  const charged = (await mandateOf(id)).totalCharged;
  if (charged <= before) throw new Error(`the keeper did not charge mandate ${id} within ${seconds}s; see ${STATE}keeper.log`);
  // The indexed charge names the transaction; its receipt has every event of the charge.
  for (let waited = 0; waited < 60; waited += 2) {
    const view = await (await fetch(`${base}/v1/payers/${payer.address}`)).json() as PayerResponse;
    const indexed = view.charges.find((c) => c.mandateId === id.toString() && c.kind === "charged");
    if (indexed !== undefined) {
      tx(`keeper charged mandate ${id}`, indexed.transaction);
      const receipt = await publicClient.getTransactionReceipt({ hash: indexed.transaction });
      const events = parseEventLogs({ abi: mandateHubAbi, logs: receipt.logs }).filter(
        (e) => e.address.toLowerCase() === hub.toLowerCase() && "mandateId" in e.args && e.args.mandateId === id,
      );
      return { events, receipt, charged, indexed };
    }
    await sleep(2_000);
  }
  throw new Error(`mandate ${id} was charged on chain but the API never indexed it; see ${STATE}api.log`);
}

/*//////////////////////////////////////////////////////////////
                              THE RUN
//////////////////////////////////////////////////////////////*/

async function run(): Promise<void> {
  await Promise.all([waitFor("api", `${base}/health`, 120), waitFor("keeper", `http://127.0.0.1:${keeperPort}/health`, 120)]);
  console.log("  the API and the keeper are up against Mainnet");
  const merchantStart = await usdcOf(merchant);

  console.log("1. Save $0.50 into the Morpho USDC vault, on a permit, with no gas from the payer");
  {
    const deadline = (await now()) + 600;
    const before = await usdcOf(payer.address);
    const response = await post<RelayResponse>("/v1/relay/savings", {
      direction: "deposit",
      owner: payer.address,
      asset: usdc,
      amount: SAVED.toString(),
      deadline,
      signature: await permit(usdc, MAINNET_USDC.permit, router, SAVED, deadline),
    });
    tx("deposit into savings", response.transaction);
    const saved = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "previewRedeem", args: [await sharesOf(payer.address)] });
    check("savings deposit", (await usdcOf(payer.address)) === before - SAVED && saved >= SAVED - 1n, `${dollars(saved)} now in savings`);
  }

  console.log("2. Install three monthly $0.10 mandates, each in one relayed transaction");
  const fromBalance = await install("balance", await terms({ ref: refFromString("weir-live-balance") }));
  const fromSavings = await install("savings", await terms({ vault, ref: refFromString("weir-live-savings") }));
  const thirdStart = BigInt((await now()) + THIRD_STARTS_IN);
  const fallback = await install("fallback", await terms({ vault, startAt: thirdStart, ref: refFromString("weir-live-fallback") }));

  console.log("3. The keeper charges the first two");
  {
    const sharesBefore = await sharesOf(payer.address);
    const [a, b] = await Promise.all([chargedByKeeper(fromBalance, 0n, 180), chargedByKeeper(fromSavings, 0n, 180)]);
    check("balance mandate charged", a.charged === MONTHLY && a.events.some((e) => e.eventName === "Charged"), `${dollars(a.charged)} in ${a.indexed.transaction}`);
    const fellBack = b.events.some((e) => e.eventName === "ChargedFromBalance");
    check("savings mandate charged from the Morpho vault", b.charged === MONTHLY && !fellBack && (await sharesOf(payer.address)) < sharesBefore, `${dollars(b.charged)}, shares went down, no fallback`);
    check("charges succeeded first time", a.receipt.status === "success" && b.receipt.status === "success", `gas used ${a.receipt.gasUsed} and ${b.receipt.gasUsed}`);
  }

  console.log("4. Take the savings back out, so the third mandate has to fall back to the balance");
  {
    const deadline = (await now()) + 600;
    const shares = await sharesOf(payer.address);
    const assets = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "previewRedeem", args: [shares] });
    const amount = assets - 1n;
    const maxShares = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "previewWithdraw", args: [amount] });
    const response = await post<RelayResponse>("/v1/relay/savings", {
      direction: "withdraw",
      owner: payer.address,
      asset: usdc,
      amount: amount.toString(),
      maxShares: maxShares.toString(),
      deadline,
      signature: await permit(vault, {}, router, maxShares, deadline),
    });
    tx("withdraw from savings", response.transaction);
    const left = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "previewRedeem", args: [await sharesOf(payer.address)] });
    check("savings withdrawn", left < CENT, `${dollars(amount)} back on the balance, ${dollars(left)} left in savings`);

    const wait = Number(thirdStart) - (await now());
    console.log(`  waiting ${Math.max(wait, 0)}s for the third mandate to fall due`);
    const walletBefore = await usdcOf(payer.address);
    const c = await chargedByKeeper(fallback, 0n, Math.max(wait, 0) + 180);
    check(
      "savings mandate fell back to the balance",
      c.charged === MONTHLY && c.events.some((e) => e.eventName === "ChargedFromBalance") && (await usdcOf(payer.address)) <= walletBefore - MONTHLY,
      `${dollars(c.charged)} from the balance, ChargedFromBalance emitted`,
    );
  }

  console.log("5. Stream $0.0001 a second, then pause it with the session key alone");
  {
    const stream = await install("stream", await terms({ period: 0, amount: STREAM_RATE, maxPerCharge: STREAM_CAP, maxTotal: STREAM_CAP, ref: refFromString("weir-live-stream") }));
    await sleep(30_000);
    await act(stream, "pause", session);
    const m = await mandateOf(stream);
    check("stream paused by the session key", m.pausedAt > 0n && m.totalCharged >= 25n * STREAM_RATE, `settled ${dollars(m.totalCharged)} for the time used`);
  }

  console.log("6. Cancel everything and return what is left");
  for (const id of Object.values(report.mandates).map(BigInt)) await act(id, "cancel", payer);
  const statuses = await Promise.all(Object.values(report.mandates).map(async (id) => mandateStatusFromIndex((await mandateOf(BigInt(id))).status)));
  check("every mandate cancelled", statuses.every((s) => s === "Cancelled"), statuses.join(", "));

  const received = (await usdcOf(merchant)) - merchantStart;
  check("merchant received", received >= 3n * MONTHLY + 25n * STREAM_RATE, `${dollars(received)}`);
  check("payer never held MON", (await publicClient.getBalance({ address: payer.address })) === 0n, "0 MON");

  const view = await (await fetch(`${base}/v1/payers/${payer.address}`)).json() as PayerResponse;
  check("the API's index matches the chain", Object.values(report.mandates).every((id) => view.mandates.some((m) => m.id === id)), `${view.mandates.length} mandates, ${view.charges.length} charges indexed`);

  // What is left goes back on a permit to the deployer, which pays the gas to move it.
  const left = await usdcOf(payer.address);
  if (left > 0n) {
    const deadline = (await now()) + 600;
    const { r, s, v, yParity } = parseSignature(await permit(usdc, MAINNET_USDC.permit, deployer.address, left, deadline));
    const wallet = createWalletClient({ account: deployer, chain, transport: http(network.rpcUrl) });
    const erc20 = parseAbi([
      "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
      "function transferFrom(address from, address to, uint256 value) returns (bool)",
    ]);
    const vNumber = v === undefined ? yParity + 27 : Number(v);
    const permitted = await wallet.writeContract({ address: usdc, abi: erc20, functionName: "permit", args: [payer.address, deployer.address, left, BigInt(deadline), vNumber, r, s] });
    await publicClient.waitForTransactionReceipt({ hash: permitted });
    const moved = await wallet.writeContract({ address: usdc, abi: erc20, functionName: "transferFrom", args: [payer.address, returnTo, left] });
    await publicClient.waitForTransactionReceipt({ hash: moved });
    tx(`return ${dollars(left)} to ${returnTo}`, moved);
  }
  check("payer emptied", (await usdcOf(payer.address)) === 0n, "nothing left with the payer");
}

let failure: unknown;
try {
  await run();
} catch (error) {
  failure = error;
  check("run finished", false, error instanceof Error ? error.message : String(error));
}
report.finishedAt = new Date().toISOString();
report.passed = failure === undefined && report.checks.every((c) => c.ok);
writeReport();
stopAll();
console.log(`\n${report.passed ? "PASSED" : "FAILED"}: report in ${STATE}report.json`);
process.exit(report.passed ? 0 : 1);
