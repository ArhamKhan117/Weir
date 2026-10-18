/**
 * Pay per request over x402, end to end, against a deployed Weir API: the way an AI agent uses it.
 *
 * It reads the API's paid demo endpoint (`/demo/fx`), which answers an unpaid request with a 402
 * offering the `weir-meter` scheme, then:
 *
 *   1. approves it once: the payer signs an EIP-2612 permit to the meter and the meter's terms, with
 *      a fresh session key as the manager and a daily cap of exactly `--calls` requests, and the
 *      relayer opens the meter in one transaction,
 *   2. makes `--calls` paid requests with the session key alone, five at a time: one signed running
 *      total each, no transaction and no prompt,
 *   3. checks the next request is refused at the daily cap, before the API does any work,
 *   4. waits for the settler to settle the total on chain, and checks the meter, the payee's
 *      balance and the API's index agree,
 *   5. stops the meter with the session key, and checks nothing more can be paid.
 *
 * The payer never holds MON. On Testnet it is a fresh key funded by the API's faucet. On Mainnet it
 * is the key in `LIVE_PAYER_KEY_FILE` (a JSON file with `privateKey`, never printed), which needs
 * `calls` times the price in USDC; that much goes to the demo's payee.
 *
 *   pnpm live:x402 --network testnet --calls 100
 *   LIVE_PAYER_KEY_FILE=.state/wallets/payer.json pnpm live:x402 --network mainnet --calls 20
 *
 * `--api <url>` points it at another Weir API. It writes `.state/x402-live/report-<chainId>.json`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createPublicClient, getAddress, http, maxUint256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  API_ROUTES,
  explorerUrl,
  formatDollarsExact,
  mandateMeterAbi,
  meterAuthorizationTypedData,
  meterCancelTypedData,
  meterDomain,
  networkFor,
  permitTypedData,
  randomNonce,
  refFromString,
  requireDeployment,
  stablecoinAbi,
  type FaucetResponse,
  type InstallMeterRequest,
  type InstallMeterResponse,
  type MeterDetail,
  type MonadChainId,
  type RelayResponse,
} from "../packages/shared/src/index.js";
import {
  createMeterFetch,
  decodePaymentRequiredHeader,
  METER_REASONS,
  meterOffersOf,
  NoMeterError,
  X402_HEADERS,
  type PaymentRequired,
} from "../packages/x402/src/index.js";
import { createChainReader } from "../packages/agent-wallet-plugin/src/core/chain.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const APIS: Record<string, { chainId: MonadChainId; url: string }> = {
  testnet: { chainId: 10143, url: "https://api-testnet-production-9789.up.railway.app" },
  mainnet: { chainId: 143, url: "https://api-mainnet-production-fc07.up.railway.app" },
};

const { values } = parseArgs({
  options: { network: { type: "string", default: "testnet" }, calls: { type: "string", default: "100" }, api: { type: "string" }, currency: { type: "string", default: "PKR" } },
});
const target = APIS[values.network ?? ""];
if (target === undefined) throw new Error("--network is testnet or mainnet");
const calls = Number(values.calls);
if (!Number.isInteger(calls) || calls < 5 || calls % 5 !== 0) throw new Error("--calls is a multiple of 5");
const apiUrl = (values.api ?? target.url).replace(/\/+$/, "");
const chainId = target.chainId;
const deployment = requireDeployment(chainId);
const recordedMeter = deployment.contracts.MandateMeter;
if (recordedMeter === undefined) throw new Error(`No MandateMeter is recorded for chain ${chainId}`);
const meterAddress: Address = recordedMeter;
const chain = networkFor(chainId).chain;
const client = createPublicClient({ chain, transport: http(process.env["MONAD_RPC_URL"] ?? chain.rpcUrls.default.http[0]) });
const demo = `${apiUrl}/demo/fx?to=${values.currency}`;

const report: { network: string; api: string; steps: { step: string; detail: string; at: string }[] } = { network: chain.name, api: apiUrl, steps: [] };
function log(step: string, detail = ""): void {
  report.steps.push({ step, detail, at: new Date().toISOString() });
  console.log(`${step}${detail === "" ? "" : `  ${detail}`}`);
}
function check(condition: boolean, what: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${what}`);
}

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

function payerAccount() {
  if (chainId === 10143) return privateKeyToAccount(generatePrivateKey());
  const file = process.env["LIVE_PAYER_KEY_FILE"];
  if (file === undefined) throw new Error("On Mainnet, LIVE_PAYER_KEY_FILE names a JSON file with the payer's privateKey");
  const { privateKey } = JSON.parse(readFileSync(file, "utf8")) as { privateKey?: Hex };
  if (privateKey === undefined) throw new Error(`${file} has no privateKey`);
  return privateKeyToAccount(privateKey);
}

const balanceOf = (asset: Address, owner: Address) => client.readContract({ address: asset, abi: stablecoinAbi, functionName: "balanceOf", args: [owner] });

async function main(): Promise<void> {
  const payer = payerAccount();
  const session = privateKeyToAccount(generatePrivateKey());
  log("payer", payer.address);
  log("session key", session.address);

  // The offer: an unpaid request costs nothing and answers 402.
  const unpaid = await fetch(demo);
  check(unpaid.status === 402, `the demo answers 402, not ${unpaid.status}`);
  const required: PaymentRequired = decodePaymentRequiredHeader(unpaid.headers.get(X402_HEADERS.paymentRequired) ?? "");
  const [first] = meterOffersOf(required);
  check(first !== undefined, "the 402 offers weir-meter");
  const offer = first.offer;
  check(offer.chainId === chainId && getAddress(offer.meter) === getAddress(meterAddress), "the offer names this network's meter");
  check(required.resource.url === demo, `the offer names the public URL (${required.resource.url})`);
  log("offer", `${formatDollarsExact(offer.price)} a request in ${offer.asset}, paid to ${offer.payTo}, facilitator ${offer.facilitator}`);

  if (chainId === 10143) {
    const granted = await api<FaucetResponse>("POST", API_ROUTES.faucet, { address: payer.address });
    log("faucet", explorerUrl(chainId, "tx", granted.transaction));
    await until("the faucet's dollars", async () => ((await balanceOf(offer.asset, payer.address)) > 0n ? true : undefined), 60_000);
  }
  const spend = offer.price * BigInt(calls);
  const startBalance = await balanceOf(offer.asset, payer.address);
  check(startBalance >= spend, `the payer holds ${formatDollarsExact(spend)} (it holds ${formatDollarsExact(startBalance)})`);
  const payeeBefore = await balanceOf(offer.asset, offer.payTo);

  // 1. Approve once: a permit and the meter's terms, one relayed transaction.
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + 15 * 60;
  const terms = {
    merchant: offer.payTo,
    asset: offer.asset,
    manager: session.address,
    periodCap: spend,
    period: 86_400,
    maxTotal: spend * 2n,
    expiresAt: BigInt(now + 86_400),
    ref: refFromString(new URL(apiUrl).host.slice(0, 32)),
  };
  const [allowance, permitNonce] = await Promise.all([
    client.readContract({ address: offer.asset, abi: stablecoinAbi, functionName: "allowance", args: [payer.address, meterAddress] }),
    client.readContract({ address: offer.asset, abi: stablecoinAbi, functionName: "nonces", args: [payer.address] }),
  ]);
  const value = allowance + terms.maxTotal > maxUint256 ? maxUint256 : allowance + terms.maxTotal;
  const permitSignature = await payer.signTypedData(
    permitTypedData({ token: { address: offer.asset, permit: await createChainReader(chainId, process.env["MONAD_RPC_URL"]).permitDomain(offer.asset) }, chainId, owner: payer.address, spender: meterAddress, value, nonce: permitNonce, deadline: BigInt(deadline) }),
  );
  const domain = meterDomain({ name: offer.name, chainId, address: meterAddress });
  const nonce = randomNonce();
  const signature = await payer.signTypedData(meterAuthorizationTypedData({ domain, payer: payer.address, terms, nonce, deadline: BigInt(deadline) }));
  const install: InstallMeterRequest = {
    permit: { token: offer.asset, owner: payer.address, value: value.toString(), deadline, signature: permitSignature },
    payer: payer.address,
    terms: { ...terms, periodCap: terms.periodCap.toString(), maxTotal: terms.maxTotal.toString(), expiresAt: Number(terms.expiresAt) },
    nonce: nonce.toString(),
    deadline,
    signature,
  };
  const opened = await api<InstallMeterResponse>("POST", API_ROUTES.meterInstall, install);
  const meterId = BigInt(opened.meterId);
  log("1. approved", `meter #${meterId}, at most ${formatDollarsExact(terms.periodCap)} a day: ${explorerUrl(chainId, "tx", opened.transactions.create)}`);
  const onChain = await client.readContract({ address: meterAddress, abi: mandateMeterAbi, functionName: "getMeter", args: [meterId] });
  check(getAddress(onChain.payer) === payer.address && getAddress(onChain.manager) === session.address && onChain.periodCap === terms.periodCap, "the meter on chain holds the signed terms");
  await until("the facilitator to know the meter", () => api<MeterDetail>("GET", API_ROUTES.meter(opened.meterId)), 60_000);

  // 2. Paid requests, signed by the session key alone, five at a time.
  const totals: bigint[] = [];
  const pay = createMeterFetch({
    signer: session,
    maxPrice: offer.price,
    onPayment: (event) => {
      if (event.settlement?.success === true) totals.push(event.total);
    },
  });
  const started = Date.now();
  for (let batch = 0; batch < calls / 5; batch += 1) {
    const answers = await Promise.all(Array.from({ length: 5 }, () => pay(demo)));
    for (const answer of answers) {
      check(answer.status === 200, `a paid request answers 200, not ${answer.status}`);
      const body = (await answer.json()) as { base: string; to: string; rate: number };
      check(body.base === "USD" && body.to === values.currency && body.rate > 0, "the API answers the rate");
    }
  }
  const elapsed = (Date.now() - started) / 1000;
  const expected = Array.from({ length: calls }, (_, i) => offer.price * BigInt(i + 1));
  check(JSON.stringify(totals.map(String)) === JSON.stringify(expected.map(String)), "each request signed the next running total, in order");
  log("2. paid", `${calls} requests in ${elapsed.toFixed(1)}s (${((elapsed * 1000) / calls).toFixed(0)} ms each), running total ${formatDollarsExact(spend)}, no transaction`);

  // 3. The next request passes the daily cap: refused, and the API does no work for it.
  const capped = await pay(demo);
  check(capped.status === 402, `the request past the cap answers 402, not ${capped.status}`);
  const refusal = decodePaymentRequiredHeader(capped.headers.get(X402_HEADERS.paymentRequired) ?? "").error;
  check(refusal === METER_REASONS.periodCap, `the refusal names the daily cap (${refusal})`);
  log("3. refused past the cap", refusal);

  // 4. Settled on chain by the settler, in one transaction.
  const settled = await until(
    "the settlement on chain",
    async () => {
      const meter = await client.readContract({ address: meterAddress, abi: mandateMeterAbi, functionName: "getMeter", args: [meterId] });
      return meter.totalCharged === spend ? meter : undefined;
    },
    15 * 60_000,
  );
  check(settled.totalCharged === spend, "the meter settled exactly the running total");
  const detail = await until("the index to see the settlement", async () => {
    const view = await api<MeterDetail>("GET", API_ROUTES.meter(opened.meterId));
    return view.totalCharged === spend.toString() && view.settlements.length > 0 ? view : undefined;
  }, 120_000);
  check(detail.accepted === spend.toString() && detail.calls === calls, "the index counts every request");
  const payeeAfter = await balanceOf(offer.asset, offer.payTo);
  check(payeeAfter - payeeBefore >= spend, "the payee received the total");
  const payerAfter = await balanceOf(offer.asset, payer.address);
  check(startBalance - payerAfter === spend, "the payer paid exactly the total");
  const settlements = detail.settlements.map((s) => explorerUrl(chainId, "tx", s.transaction as Hex)).join(", ");
  log("4. settled", `${formatDollarsExact(spend)} in ${detail.settlements.length} transaction(s): ${settlements}`);

  // 5. Stopped by the session key; nothing more can be paid.
  const cancelNonce = randomNonce();
  const cancelDeadline = Math.floor(Date.now() / 1000) + 15 * 60;
  const cancelSignature = await session.signTypedData(meterCancelTypedData({ domain, meterId, nonce: cancelNonce, deadline: BigInt(cancelDeadline) }));
  const stopped = await api<RelayResponse>("POST", API_ROUTES.meterCancel, {
    meterId: opened.meterId,
    signer: session.address,
    nonce: cancelNonce.toString(),
    deadline: cancelDeadline,
    signature: cancelSignature,
  });
  log("5. stopped", explorerUrl(chainId, "tx", stopped.transaction));
  const closed = await client.readContract({ address: meterAddress, abi: mandateMeterAbi, functionName: "getMeter", args: [meterId] });
  check(closed.status === 2, "the meter is cancelled on chain");
  await until("the index to see the stop", async () => ((await api<MeterDetail>("GET", API_ROUTES.meter(opened.meterId))).status === "Cancelled" ? true : undefined), 120_000);
  const after = await createMeterFetch({ signer: session, maxPrice: offer.price })(demo).catch((error: unknown) => error);
  check(after instanceof NoMeterError, "a stopped meter pays nothing more");
  log("   nothing more can be paid");
}

const dir = `${ROOT}.state/x402-live/`;
mkdirSync(dir, { recursive: true });
try {
  await main();
  log("done");
} finally {
  writeFileSync(`${dir}report-${chainId}.json`, `${JSON.stringify(report, null, 2)}\n`);
}
