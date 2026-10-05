#!/usr/bin/env node
// Records a broadcast deployment in packages/shared/src/deployments.json.
//
// Reads `broadcast/<script>.s.sol/<chainId>/run-latest.json`, the broadcast's own record, never the
// simulation's printout, and takes each CREATE's address and transaction.
//
// `Deploy`, the default, writes the network's whole entry: the block of the first CREATE is read
// from the chain, and the accepted assets are read back from the deployed hub itself, so the record
// says what the chain says. On Testnet the run either created the test token and savings vault or
// reused two already deployed (`REUSE_TEST_STABLECOIN`, `REUSE_TEST_SAVINGS_VAULT`); reused ones
// are recorded from the run's own return value, once the new hub accepts the token and the vault
// is over it, with their original transactions kept. A savings router already recorded there is
// kept while every asset it routes is still accepted under the same symbol, and dropped with a
// warning otherwise.
//
// `DeploySavingsRouter` adds the router to the network's existing entry: `contracts.SavingsRouter`,
// its transaction, and `savings`, each routed asset's symbol mapped to its vault, read back from
// the deployed router. Nothing else in the entry changes.
//
//   node --env-file=.env scripts/record-deployment.mjs [Deploy|DeploySavingsRouter]

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS = ["Deploy", "DeploySavingsRouter"];

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const script = process.argv[2] ?? "Deploy";
const chainId = Number(process.env.MONAD_CHAIN_ID);
const rpcUrl = process.env.MONAD_RPC_URL;
const name = process.env.EIP712_NAME;
if (!SCRIPTS.includes(script)) throw new Error(`unknown script ${script}: expected one of ${SCRIPTS.join(", ")}`);
if (![143, 10143].includes(chainId)) throw new Error("MONAD_CHAIN_ID must be 143 or 10143");
if (!rpcUrl) throw new Error("MONAD_RPC_URL is not set");
if (script === "Deploy" && !name) throw new Error("EIP712_NAME is not set");

/** Every CREATE in the script's latest broadcast on this chain, each checked to have landed. */
const readBroadcast = (scriptName) => {
  const path = join(root, `broadcast/${scriptName}.s.sol/${chainId}/run-latest.json`);
  const run = JSON.parse(readFileSync(path, "utf8"));
  const created = run.transactions.filter((tx) => tx.transactionType === "CREATE");
  const receipts = new Map(run.receipts.map((receipt) => [receipt.transactionHash, receipt]));
  for (const tx of created) {
    const receipt = receipts.get(tx.hash);
    if (receipt === undefined || receipt.status !== "0x1") throw new Error(`${tx.contractName} did not land: ${tx.hash}`);
  }
  return {
    created,
    receipts,
    byName: Object.fromEntries(created.map((tx) => [tx.contractName, tx])),
    returns: run.returns,
  };
};

const rpc = async (method, params) => {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};

const call = (to, signature) =>
  execFileSync("cast", ["call", to, signature, "--rpc-url", rpcUrl], { encoding: "utf8" }).trim();

// The broadcast artifact spells addresses in lowercase; the record uses the EIP-55 checksum.
const checksum = (address) => execFileSync("cast", ["to-check-sum-address", address], { encoding: "utf8" }).trim();

const symbolOf = (token) => call(token, "symbol()(string)").replace(/^"|"$/g, "");

const STAND_INS = ["TestStablecoin", "TestSavingsVault"];

/**
 * The Testnet stand-ins a `Deploy` run reused rather than created, by name, or `undefined` when it
 * created both. Read from the run's return value, `Deploy.Deployment` as
 * `(hub, charger, testStablecoin, testSavingsVault)`: a reused address there is exact, where a
 * created one would be the simulation's.
 */
const reusedStandIns = (byName, returns) => {
  const created = STAND_INS.filter((name) => byName[name] !== undefined);
  if (created.length === STAND_INS.length) return undefined;
  if (created.length !== 0) throw new Error(`the broadcast created ${created[0]} but not the other stand-in`);

  const value = returns?.deployment?.value;
  const addresses = typeof value === "string" ? (value.match(/0x[0-9a-fA-F]{40}/g) ?? []) : [];
  if (addresses.length !== 4) throw new Error("the run's return value does not name the stand-ins it reused");
  return { TestStablecoin: checksum(addresses[2]), TestSavingsVault: checksum(addresses[3]) };
};

/** The router's routes as `[asset, vault]` pairs, checksummed, in the order it lists them. */
const routesOf = (router) => {
  const addresses = call(router, "routes()((address,address)[])").match(/0x[0-9a-fA-F]{40}/g) ?? [];
  if (addresses.length === 0 || addresses.length % 2 !== 0) throw new Error(`${router} answered no routes`);
  const pairs = [];
  for (let i = 0; i < addresses.length; i += 2) pairs.push([checksum(addresses[i]), checksum(addresses[i + 1])]);
  return pairs;
};

/** `entry` with `savings` placed right after `assets`, every other key where it was. */
const withSavings = (entry, savings) => {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "savings") continue;
    out[key] = value;
    if (key === "assets") out.savings = savings;
  }
  return out;
};

const recordPath = join(root, "packages/shared/src/deployments.json");
const record = JSON.parse(readFileSync(recordPath, "utf8"));
const previous = record.networks[String(chainId)];

let entry;
if (script === "Deploy") {
  const { created, receipts, byName, returns } = readBroadcast("Deploy");
  for (const required of ["MandateHub", "MandateCharger"]) {
    if (byName[required] === undefined) throw new Error(`the broadcast created no ${required}`);
  }

  const hub = byName.MandateHub.contractAddress;
  const assetAddresses = call(hub, "acceptedAssets()(address[])").replace(/[[\]\s]/g, "").split(",");
  const assets = {};
  for (const address of assetAddresses) assets[symbolOf(address)] = checksum(address);

  const forwarders = {
    forwarder: checksum(call(byName.MandateCharger.contractAddress, "FORWARDER()(address)")),
    simulationForwarder: checksum(call(byName.MandateCharger.contractAddress, "SIMULATION_FORWARDER()(address)")),
  };

  // Reused stand-ins stay recorded ahead of what this run created, as a fresh run lists them, and
  // keep the transactions that created them when the previous entry recorded the same addresses.
  const reused = chainId === 10143 ? reusedStandIns(byName, returns) : undefined;
  const reusedContracts = {};
  const reusedTransactions = {};
  if (reused !== undefined) {
    const { TestStablecoin: token, TestSavingsVault: vault } = reused;
    if (assets[symbolOf(token)] !== token) throw new Error(`the new hub does not accept the reused ${token}`);
    if (checksum(call(vault, "asset()(address)")) !== token) throw new Error(`the reused ${vault} is not over ${token}`);
    for (const [contract, address] of Object.entries(reused)) {
      reusedContracts[contract] = address;
      if (previous?.contracts?.[contract] === address && previous.transactions?.[contract] !== undefined) {
        reusedTransactions[contract] = previous.transactions[contract];
      } else {
        console.warn(`reused ${contract} ${address} is not in the previous entry; its transaction is not recorded.`);
      }
    }
  }

  const firstReceipt = receipts.get(created[0].hash);
  const firstBlock = await rpc("eth_getBlockByNumber", [firstReceipt.blockNumber, false]);

  entry = {
    network: chainId === 143 ? "Monad" : "Monad Testnet",
    chainId,
    deployedAt: new Date(Number(firstBlock.timestamp) * 1000).toISOString(),
    startBlock: Number(firstReceipt.blockNumber),
    deployer: checksum(created[0].transaction.from),
    eip712: { name, version: "1" },
    contracts: {
      ...reusedContracts,
      ...Object.fromEntries(created.map((tx) => [tx.contractName, checksum(tx.contractAddress)])),
    },
    assets,
    chainlink: forwarders,
    transactions: { ...reusedTransactions, ...Object.fromEntries(created.map((tx) => [tx.contractName, tx.hash])) },
  };

  // The router does not depend on the hub, so it survives a new hub as long as the assets it
  // routes are still the ones the hub accepts.
  const router = previous?.contracts?.SavingsRouter;
  if (router !== undefined) {
    const stillAccepted = routesOf(router).every(([asset]) => assets[symbolOf(asset)] === asset);
    if (stillAccepted) {
      entry.contracts.SavingsRouter = router;
      entry.transactions.SavingsRouter = previous.transactions.SavingsRouter;
      entry = withSavings(entry, previous.savings);
    } else {
      console.warn(`dropped SavingsRouter ${router}: it routes an asset this deployment does not accept.`);
      console.warn("Redeploy it with script/DeploySavingsRouter.s.sol and record it.");
    }
  }
} else {
  if (previous === undefined) {
    throw new Error(`nothing is recorded on chain ${chainId}: record the Deploy broadcast first`);
  }
  const { byName } = readBroadcast("DeploySavingsRouter");
  const tx = byName.SavingsRouter;
  if (tx === undefined) throw new Error("the broadcast created no SavingsRouter");

  const router = checksum(tx.contractAddress);
  const savings = {};
  for (const [asset, vault] of routesOf(router)) savings[symbolOf(asset)] = vault;

  entry = withSavings(
    {
      ...previous,
      contracts: { ...previous.contracts, SavingsRouter: router },
      transactions: { ...previous.transactions, SavingsRouter: tx.hash },
    },
    savings,
  );
}

record.networks[String(chainId)] = entry;
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`recorded ${script} on ${entry.network} (entry from block ${entry.startBlock}):`);
for (const [contract, address] of Object.entries(entry.contracts)) console.log(`  ${contract.padEnd(17)} ${address}`);
for (const [symbol, vault] of Object.entries(entry.savings ?? {})) console.log(`  savings ${symbol.padEnd(9)} ${vault}`);
