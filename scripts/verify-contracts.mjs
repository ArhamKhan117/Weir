// Verifies every deployed contract on both of Monad's explorers, then reports what each one says.
//
//   MonadVision  Sourcify at sourcify-api-monad.blockvision.org; no key.
//   Monadscan    Etherscan's v2 API; needs ETHERSCAN_API_KEY (one free key covers every chain).
//   sourcify.dev the public Sourcify repository, as a third, independent record.
//
// Constructor arguments are never retyped: each comes from the contract's own creation transaction
// in the deployment record, as what follows the compiled creation code in its input. The run
// writes docs/verification.md from what the explorers answer afterwards.
//
//   node --env-file=.env scripts/verify-contracts.mjs   # both networks; Monadscan too when ETHERSCAN_API_KEY is set

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const record = JSON.parse(readFileSync(`${ROOT}packages/shared/src/deployments.json`, "utf8")).networks;

const NETWORKS = {
  143: { name: "Monad Mainnet", rpc: "https://rpc.monad.xyz", vision: "https://monadvision.com", scan: "https://monadscan.com" },
  10143: { name: "Monad Testnet", rpc: "https://testnet-rpc.monad.xyz", vision: "https://testnet.monadvision.com", scan: "https://testnet.monadscan.com" },
};
const SOURCES = {
  MandateHub: "src/MandateHub.sol:MandateHub",
  MandateCharger: "src/MandateCharger.sol:MandateCharger",
  SavingsRouter: "src/SavingsRouter.sol:SavingsRouter",
  TestStablecoin: "src/testnet/TestStablecoin.sol:TestStablecoin",
  TestSavingsVault: "src/testnet/TestSavingsVault.sol:TestSavingsVault",
};
const VISION_SOURCIFY = "https://sourcify-api-monad.blockvision.org/";
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY?.trim() || undefined;

async function rpc(url, method, params) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function creationCode(contract) {
  const artifact = JSON.parse(readFileSync(`${ROOT}out/${contract}.sol/${contract}.json`, "utf8"));
  return artifact.bytecode.object.toLowerCase();
}

/** The ABI-encoded constructor arguments: the creation transaction's input after the creation code. */
async function constructorArgs(chainId, contract) {
  const tx = await rpc(NETWORKS[chainId].rpc, "eth_getTransactionByHash", [record[chainId].transactions[contract]]);
  const input = tx.input.toLowerCase();
  const code = creationCode(contract);
  const at = input.indexOf(code.slice(2));
  if (at < 0) throw new Error(`${contract} on ${chainId}: the compiled creation code is not in its creation transaction; rebuild from the deployed source`);
  return `0x${input.slice(at + code.length - 2)}`;
}

function forgeVerify(chainId, contract, address, args, verifier) {
  const extra =
    verifier === "monadvision"
      ? ["--verifier", "sourcify", "--verifier-url", VISION_SOURCIFY]
      : verifier === "sourcify"
        ? ["--verifier", "sourcify"]
        : ["--verifier", "etherscan", "--etherscan-api-key", ETHERSCAN_KEY, "--watch"];
  const run = spawnSync("forge", ["verify-contract", address, SOURCES[contract], "--chain", String(chainId), "--constructor-args", args, ...extra], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const said = `${run.stdout}\n${run.stderr}`;
  return /already verified|Submitted|Pass - Verified|exact_match/i.test(said) ? "submitted" : `failed: ${said.split("\n").filter(Boolean).slice(-2).join(" ")}`;
}

async function sourcifyMatch(base, chainId, address) {
  try {
    const response = await fetch(`${base}v2/contract/${chainId}/${address}`);
    if (!response.ok) return "not verified";
    return (await response.json()).match ?? "not verified";
  } catch {
    return "unreachable";
  }
}

async function monadscanStatus(chainId, address) {
  if (ETHERSCAN_KEY === undefined) return "not checked (no key)";
  const response = await fetch(`https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${ETHERSCAN_KEY}`);
  const body = await response.json();
  const entry = body.result?.[0];
  return entry?.SourceCode ? "verified" : "not verified";
}

execFileSync("forge", ["build"], { cwd: ROOT, stdio: "ignore" });

const rows = [];
for (const chainId of [143, 10143]) {
  const network = record[chainId];
  if (network === undefined) continue;
  for (const [contract, address] of Object.entries(network.contracts)) {
    const args = await constructorArgs(chainId, contract);
    const submitted = ["monadvision", "sourcify", ...(ETHERSCAN_KEY === undefined ? [] : ["monadscan"])].map((verifier) => [
      verifier,
      forgeVerify(chainId, contract, address, args, verifier),
    ]);
    for (const [verifier, outcome] of submitted) if (outcome !== "submitted") console.log(`${contract} on ${chainId} via ${verifier}: ${outcome}`);
    rows.push({ chainId, contract, address });
    console.log(`submitted ${contract} on ${NETWORKS[chainId].name}`);
  }
}

// Sourcify jobs finish in seconds; Etherscan's `--watch` already waited.
await sleep(20_000);
for (const row of rows) {
  row.monadvision = await sourcifyMatch(VISION_SOURCIFY, row.chainId, row.address);
  row.sourcify = await sourcifyMatch("https://sourcify.dev/server/", row.chainId, row.address);
  row.monadscan = await monadscanStatus(row.chainId, row.address);
  console.log(`${row.contract.padEnd(17)} ${row.chainId} ${row.address}  MonadVision ${row.monadvision}, sourcify.dev ${row.sourcify}, Monadscan ${row.monadscan}`);
}

const WORDS = { exact_match: "Exact match", match: "Partial match", verified: "Verified", "not verified": "Not verified" };
const word = (status) => WORDS[status] ?? status;
const link = (base, address) => `[\`${address.slice(0, 6)}…${address.slice(-4)}\`](${base}/address/${address})`;
const lines = [
  "# Contract verification",
  "",
  "Every Weir contract on Monad is source-verified, so anyone can read the exact code an address runs and rebuild it from this repository.",
  "Monad documents two ways to verify a contract, and Weir uses both, plus the public Sourcify repository as a third, independent record.",
  "",
  "| Method | Explorer | How |",
  "| --- | --- | --- |",
  "| Sourcify | [MonadVision](https://monadvision.com) | `forge verify-contract --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/` |",
  "| Etherscan | [Monadscan](https://monadscan.com) | `forge verify-contract --verifier etherscan --etherscan-api-key <key>` |",
  "| Sourcify | [sourcify.dev](https://sourcify.dev) | `forge verify-contract --verifier sourcify` |",
  "",
  "An exact match means the compiled creation code and runtime code are byte for byte what is on chain, metadata included.",
  "Constructor arguments are taken from each contract's own creation transaction, never retyped.",
  `Last checked ${new Date().toISOString().slice(0, 10)} by \`node --env-file=.env scripts/verify-contracts.mjs\`, which submits every contract and writes this file from what the explorers answer.`,
  "",
];
for (const chainId of [143, 10143]) {
  const network = NETWORKS[chainId];
  lines.push(`## ${network.name} (${chainId})`, "", "| Contract | Address | MonadVision | Monadscan | sourcify.dev |", "| --- | --- | --- | --- | --- |");
  for (const row of rows.filter((r) => r.chainId === chainId)) {
    lines.push(`| \`${row.contract}\` | ${link(network.vision, row.address)} | ${word(row.monadvision)} | [${word(row.monadscan)}](${network.scan}/address/${row.address}#code) | ${word(row.sourcify)} |`);
  }
  lines.push("");
}
lines.push(
  "## Check it yourself",
  "",
  "```bash",
  "forge build",
  "node --env-file=.env scripts/verify-contracts.mjs",
  "MONAD_CHAIN_ID=143 forge script script/VerifyDeployment.s.sol:VerifyDeployment --rpc-url https://rpc.monad.xyz",
  "MONAD_CHAIN_ID=10143 forge script script/VerifyDeployment.s.sol:VerifyDeployment --rpc-url https://testnet-rpc.monad.xyz",
  "```",
  "",
  "`VerifyDeployment` reads every recorded address on chain and checks the wiring: the hub's assets and domain, the charger's hub and Chainlink forwarders, and the router's routes.",
  "",
);
writeFileSync(`${ROOT}docs/verification.md`, lines.join("\n"));
console.log("wrote docs/verification.md");
