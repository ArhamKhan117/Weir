/**
 * End-to-end smoke run against the deployed contracts, the way a real payer uses them.
 *
 * A brand-new payer that never holds gas signs everything; the relayer submits; the keeper
 * charges. It exercises, on chain and in order:
 *
 *   1. a periodic mandate installed from two signatures (a token permit and the mandate terms),
 *   2. a charge through `MandateCharger`, checked to the base unit at the merchant,
 *   3. a per-second mandate drawn from a savings vault ("earn until charged"),
 *   4. a pause signed by the session key alone, which settles the time used.
 *
 * Testnet only for now: it funds the payer from the test stablecoin's faucet.
 *
 *   pnpm exec tsx --env-file=.env scripts/smoke.ts
 */

import {
  type Address,
  type Hex,
  createWalletClient,
  getAddress,
  http,
  maxUint256,
  parseEventLogs,
  zeroAddress,
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
  mandateChargerAbi,
  mandateHubAbi,
  networkFor,
  permitTypedData,
  randomNonce,
  refFromString,
  requireDeployment,
  requireSecret,
  stablecoinAbi,
  type MandateTerms,
} from "../packages/shared/src/index.js";

const network = loadNetworkConfig();
if (network.chainId !== 10143) throw new Error("The smoke run funds from a Testnet faucet; set MONAD_CHAIN_ID=10143");

const deployment = requireDeployment(network.chainId);
const chain = networkFor(network.chainId).chain;
const publicClient = createMonadClient(network);

const relayer = privateKeyToAccount(requireSecret("RELAYER_PRIVATE_KEY").reveal() as Hex);
const keeper = privateKeyToAccount(requireSecret("KEEPER_PRIVATE_KEY").reveal() as Hex);
const relayerClient = createWalletClient({ account: relayer, chain, transport: http(network.rpcUrl) });
const keeperClient = createWalletClient({ account: keeper, chain, transport: http(network.rpcUrl) });

// Fresh identities every run: a payer and its session key that never hold gas, and a merchant.
const payer = privateKeyToAccount(generatePrivateKey());
const session = privateKeyToAccount(generatePrivateKey());
const merchant = privateKeyToAccount(generatePrivateKey()).address;

const hub = deployment.contracts.MandateHub;
const charger = deployment.contracts.MandateCharger;
const tAUSD = getAddress(deployment.contracts.TestStablecoin ?? "");
const savings = getAddress(deployment.contracts.TestSavingsVault ?? "");
const domain = hubDomain({ name: deployment.eip712.name, chainId: network.chainId, address: hub });

const DOLLAR = 1_000_000n;

type Client = typeof relayerClient;

/**
 * Sends a call with an estimated gas limit plus a bounded margin: Monad bills the limit, not the
 * gas used, so a flat generous limit is paid in full every time.
 */
async function send(client: Client, request: Parameters<Client["writeContract"]>[0], label: string) {
  const estimate = await publicClient.estimateContractGas({ ...request, account: client.account } as never);
  const gas = (estimate * 12n) / 10n + 10_000n;
  const hash = await client.writeContract({ ...request, gas } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ${label.padEnd(34)} ${explorerUrl(network.chainId, "tx", hash)}  gas ${receipt.gasUsed}/${gas}`);
  return receipt;
}

const balanceOf = (token: Address, who: Address) =>
  publicClient.readContract({ address: token, abi: stablecoinAbi, functionName: "balanceOf", args: [who] });

async function permit(token: { address: Address; name: string }, value: bigint, deadline: bigint) {
  const nonce = await publicClient.readContract({
    address: token.address,
    abi: stablecoinAbi,
    functionName: "nonces",
    args: [payer.address],
  });
  const signature = await payer.signTypedData(
    permitTypedData({
      token: { address: token.address, permit: { name: token.name, version: "1" } },
      chainId: network.chainId,
      owner: payer.address,
      spender: hub,
      value,
      nonce,
      deadline,
    }),
  );
  const r = signature.slice(0, 66) as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = Number.parseInt(signature.slice(130, 132), 16);
  await send(
    relayerClient,
    {
      address: token.address,
      abi: stablecoinAbi,
      functionName: "permit",
      args: [payer.address, hub, value, deadline, v, r, s],
    } as never,
    `permit ${token.name}`,
  );
}

async function install(terms: MandateTerms, label: string): Promise<bigint> {
  const nonce = randomNonce();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await payer.signTypedData(createMandateTypedData({ domain, payer: payer.address, terms, nonce, deadline }));
  const receipt = await send(
    relayerClient,
    {
      address: hub,
      abi: mandateHubAbi,
      functionName: "createMandateWithSig",
      args: [payer.address, terms, nonce, deadline, signature],
    } as never,
    label,
  );
  const [created] = parseEventLogs({ abi: mandateHubAbi, eventName: "MandateCreated", logs: receipt.logs });
  if (created === undefined) throw new Error("no MandateCreated in the install receipt");
  return created.args.mandateId;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const now = BigInt(Math.floor(Date.now() / 1000));
  console.log(`Weir smoke run on ${deployment.network}`);
  console.log(`  payer ${payer.address} (holds no MON), session key ${session.address}, merchant ${merchant}`);

  console.log("1. A periodic mandate from two signatures");
  await send(relayerClient, { address: tAUSD, abi: stablecoinAbi, functionName: "mint", args: [payer.address, 50n * DOLLAR] } as never, "faucet: 50 tAUSD to the payer");
  await permit({ address: tAUSD, name: "Test AUSD" }, 30n * DOLLAR, now + 600n);
  const periodic = await install(
    {
      merchant,
      asset: tAUSD,
      vault: zeroAddress,
      manager: session.address,
      amount: 5n * DOLLAR,
      period: 60,
      startAt: 0n,
      maxPerCharge: 5n * DOLLAR,
      maxTotal: 30n * DOLLAR,
      expiresAt: now + 86_400n,
      ref: refFromString("smoke-monthly"),
    },
    "signed install, periodic",
  );

  console.log("2. The keeper charges it through MandateCharger");
  await send(keeperClient, { address: charger, abi: mandateChargerAbi, functionName: "chargeMany", args: [[periodic]] } as never, "chargeMany");
  const afterFirst = await balanceOf(tAUSD, merchant);
  if (afterFirst !== 5n * DOLLAR) throw new Error(`merchant holds ${afterFirst}, expected ${5n * DOLLAR}`);
  console.log(`  merchant received exactly ${formatDollarsExact(afterFirst)}`);

  console.log("3. A per-second mandate drawn from savings");
  await send(relayerClient, { address: tAUSD, abi: stablecoinAbi, functionName: "mint", args: [relayer.address, 20n * DOLLAR] } as never, "faucet: 20 tAUSD to the relayer");
  await send(relayerClient, { address: tAUSD, abi: stablecoinAbi, functionName: "approve", args: [savings, 20n * DOLLAR] } as never, "approve the savings vault");
  await send(
    relayerClient,
    {
      address: savings,
      abi: [{ type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ name: "shares", type: "uint256" }] }],
      functionName: "deposit",
      args: [20n * DOLLAR, payer.address],
    } as never,
    "deposit 20 tAUSD into the payer's savings",
  );
  await permit({ address: savings, name: "Test AUSD Savings" }, maxUint256, now + 600n);
  const stream = await install(
    {
      merchant,
      asset: tAUSD,
      vault: savings,
      manager: session.address,
      amount: 1_000n,
      period: 0,
      startAt: 0n,
      maxPerCharge: 1n * DOLLAR,
      maxTotal: 10n * DOLLAR,
      expiresAt: now + 86_400n,
      ref: refFromString("smoke-meter"),
    },
    "signed install, per second from savings",
  );
  await sleep(6_000);
  const before = await balanceOf(tAUSD, merchant);
  const quoted = await publicClient.readContract({ address: hub, abi: mandateHubAbi, functionName: "quoteCharge", args: [stream] });
  await send(keeperClient, { address: hub, abi: mandateHubAbi, functionName: "charge", args: [stream] } as never, "charge the stream");
  const streamed = (await balanceOf(tAUSD, merchant)) - before;
  if (streamed < quoted) throw new Error(`streamed ${streamed}, quoted at least ${quoted}`);
  console.log(`  streamed ${formatDollarsExact(streamed)} from savings for the seconds elapsed`);

  console.log("4. The session key pauses the stream without the owner key");
  await sleep(4_000);
  const nonce = randomNonce();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await session.signTypedData(actionTypedData({ domain, mandateId: stream, action: "pause", nonce, deadline }));
  const beforePause = await balanceOf(tAUSD, merchant);
  await send(
    relayerClient,
    { address: hub, abi: mandateHubAbi, functionName: "actWithSig", args: [stream, 2, session.address, nonce, deadline, signature] } as never,
    "pause signed by the session key",
  );
  const settled = (await balanceOf(tAUSD, merchant)) - beforePause;
  const record = await publicClient.readContract({ address: hub, abi: mandateHubAbi, functionName: "getMandate", args: [stream] });
  if (record.pausedAt === 0n) throw new Error("the stream is not paused");
  console.log(`  paused; the pause settled ${formatDollarsExact(settled)} for the time used`);

  const payerGas = await publicClient.getBalance({ address: payer.address });
  console.log(`Done. The payer's MON balance is ${payerGas}: it never paid gas.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
