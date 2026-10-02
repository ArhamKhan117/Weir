/**
 * Writes everything in this indexer that depends on a deployment, from the repository's own
 * records, so a redeployed hub is one command here:
 *
 *   config.yaml        chains, addresses and start blocks    packages/shared/src/deployments.json
 *   abis/*.json        the hub's and the charger's ABIs      packages/shared/src/abi.ts
 *   src/networks.ts    per chain: assets, charger, CRE forwarders, and the revert selectors
 *                      a batch can report, named
 *
 *   pnpm sync           write them
 *   pnpm sync:check     exit 1 when any of them is out of date
 *
 * Every output is committed. The hosted service builds from this directory alone, so nothing the
 * indexer runs may read outside it; this script is the only thing that does, and only here.
 *
 * The indexed events are listed below rather than taken from the ABI: an event the contracts gain
 * fails the sync until someone decides how it is indexed, instead of arriving unhandled.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { toFunctionSelector, type Abi, type AbiParameter } from "viem";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const projectDir = here("../");
const deploymentsPath = here("../../../packages/shared/src/deployments.json");
const abiPath = here("../../../packages/shared/src/abi.ts");

interface IndexedContract {
  name: string;
  abiExport: string;
  events: string[];
  ignored: string[];
}

/**
 * The contracts indexed, the export in `abi.ts` each ABI comes from, the events handled, and the
 * events deliberately left out.
 */
const CONTRACTS: IndexedContract[] = [
  {
    name: "MandateHub",
    abiExport: "mandateHubAbi",
    events: [
      "MandateCreated",
      "Charged",
      "ChargedFromBalance",
      "ChargeFailed",
      "MandateCancelled",
      "MandatePaused",
      "MandateResumed",
      "ManagerChanged",
      "NonceInvalidated",
    ],
    // ERC-5267's announcement of a new EIP-712 domain. The hub's domain is fixed at deployment,
    // so it never fires.
    ignored: ["EIP712DomainChanged"],
  },
  { name: "MandateCharger", abiExport: "mandateChargerAbi", events: ["ReportCharged", "ChargeReverted"], ignored: [] },
];

/**
 * Facts about each Monad network rather than about this deployment, as in
 * packages/shared/src/chains.ts: the HyperSync endpoint the indexer reads, and a keyless public
 * RPC, for the one thing HyperSync does not hand a block handler (the time of a block) and as the
 * fallback source. `ENVIO_RPC_URL_<chainId>` overrides it for both.
 */
const CHAINS: Record<number, { hypersync: string; rpc: string }> = {
  143: { hypersync: "https://monad.hypersync.xyz", rpc: "https://rpc.monad.xyz" },
  10143: { hypersync: "https://monad-testnet.hypersync.xyz", rpc: "https://testnet-rpc.monad.xyz" },
};

/** Revert selectors every EVM reports the same way, besides the contracts' own errors. */
const BUILTIN_ERRORS: Record<string, string> = { "0x08c379a0": "Error(string)", "0x4e487b71": "Panic(uint256)" };

function fail(message: string): never {
  console.error(`sync: ${message}`);
  process.exit(1);
}

/** One `export const <name> = [...] as const;` from abi.ts, which the generator writes as JSON. */
function readAbi(source: string, exportName: string): Abi {
  const start = source.indexOf(`export const ${exportName} = `);
  if (start < 0) fail(`${exportName} is not exported by ${abiPath}`);
  const open = source.indexOf("[", start);
  const close = source.indexOf("] as const;", open);
  if (open < 0 || close < 0) fail(`${exportName} in ${abiPath} is not a JSON array followed by "as const"`);
  return JSON.parse(source.slice(open, close + 1));
}

/** The canonical type of an ABI parameter, tuples expanded, for a selector. */
function canonicalType(param: AbiParameter): string {
  if (!param.type.startsWith("tuple") || !("components" in param)) return param.type;
  return `(${param.components.map(canonicalType).join(",")})${param.type.slice("tuple".length)}`;
}

function errorSelectors(abis: Abi[]): [string, string][] {
  const named = new Map(Object.entries(BUILTIN_ERRORS));
  for (const abi of abis) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const signature = `${item.name}(${item.inputs.map(canonicalType).join(",")})`;
      const selector = toFunctionSelector(signature);
      const existing = named.get(selector);
      if (existing !== undefined && existing !== signature) fail(`${existing} and ${signature} share ${selector}`);
      named.set(selector, signature);
    }
  }
  return [...named.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function checkEvents(contract: IndexedContract, abi: Abi): void {
  const inAbi = abi.flatMap((item) => (item.type === "event" ? [item.name] : []));
  const missing = contract.events.filter((name) => !inAbi.includes(name));
  const unhandled = inAbi.filter((name) => !contract.events.includes(name) && !contract.ignored.includes(name));
  if (missing.length > 0) fail(`${contract.name} has no event ${missing.join(", ")}`);
  if (unhandled.length > 0) {
    fail(`${contract.name} emits ${unhandled.join(", ")}, which the indexer does not handle yet: add a handler and list it here`);
  }
}

interface DeploymentRecord {
  networks?: Record<
    string,
    {
      network: string;
      chainId: number;
      startBlock: number;
      contracts?: Record<string, string>;
      assets?: Record<string, string>;
      chainlink?: { forwarder?: string; simulationForwarder?: string };
    }
  >;
}

interface Network {
  chainId: number;
  name: string;
  startBlock: number;
  hub: string;
  charger: string;
  forwarder: string;
  simulationForwarder: string;
  assets: [string, string][];
  hypersync: string;
  rpc: string;
}

function networksOf(deployments: DeploymentRecord): Network[] {
  const entries = Object.values(deployments.networks ?? {});
  if (entries.length === 0) fail(`${deploymentsPath} records no network`);
  return entries
    .map((entry) => {
      const chain = CHAINS[entry.chainId];
      if (chain === undefined) fail(`chain ${entry.chainId} is not a Monad network this script knows`);
      const { MandateHub: hub, MandateCharger: charger } = entry.contracts ?? {};
      if (hub === undefined || charger === undefined) fail(`chain ${entry.chainId} records no MandateHub or MandateCharger`);
      if (!Number.isInteger(entry.startBlock)) fail(`chain ${entry.chainId} records no start block`);
      return {
        chainId: entry.chainId,
        name: entry.network,
        startBlock: entry.startBlock,
        hub: hub.toLowerCase(),
        charger: charger.toLowerCase(),
        forwarder: (entry.chainlink?.forwarder ?? "").toLowerCase(),
        simulationForwarder: (entry.chainlink?.simulationForwarder ?? "").toLowerCase(),
        assets: Object.entries(entry.assets ?? {})
          .map(([symbol, address]): [string, string] => [address.toLowerCase(), symbol])
          .sort(([a], [b]) => a.localeCompare(b)),
        hypersync: chain.hypersync,
        rpc: chain.rpc,
      };
    })
    .sort((a, b) => a.chainId - b.chainId);
}

const GENERATED_YAML = [
  "# Generated by scripts/sync.ts from packages/shared/src/deployments.json and",
  "# packages/shared/src/abi.ts. Do not edit: update the deployment record, then run `pnpm sync`.",
];

function renderConfig(networks: Network[]): string {
  const lines = [
    ...GENERATED_YAML,
    "# yaml-language-server: $schema=./node_modules/envio/evm.schema.json",
    "name: weir",
    "description: Weir mandates, charges, CRE reports and merchant revenue on Monad",
    "# Every address the indexer stores or keys an entity by is lowercase, so a GraphQL filter needs",
    "# no case folding.",
    "address_format: lowercase",
    "# Blocks carry their number, time and hash already; charges also need who sent them and to",
    "# what, which is how a keeper batch is told from a direct call.",
    "field_selection:",
    "  transaction_fields:",
    "    - hash",
    "    - from",
    "    - to",
    "contracts:",
  ];
  for (const contract of CONTRACTS) {
    lines.push(`  - name: ${contract.name}`, `    abi_file_path: ./abis/${contract.name}.json`, "    events:");
    for (const event of contract.events) lines.push(`      - event: ${event}`);
  }
  lines.push("chains:");
  for (const network of networks) {
    lines.push(
      `  - id: ${network.chainId} # ${network.name}`,
      `    start_block: ${network.startBlock}`,
      "    hypersync_config:",
      `      url: ${network.hypersync}`,
      "    # Takes over only when HyperSync has shown no new block for 20 seconds. The public RPC",
      "    # answers at most 100 blocks per eth_getLogs.",
      "    rpc:",
      `      - url: \${ENVIO_RPC_URL_${network.chainId}:-${network.rpc}}`,
      "        for: fallback",
      "        initial_block_interval: 100",
      "        interval_ceiling: 100",
      "    contracts:",
      "      - name: MandateHub",
      `        address: "${network.hub}"`,
      "      - name: MandateCharger",
      `        address: "${network.charger}"`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderNetworks(networks: Network[], errors: [string, string][]): string {
  const lines = [
    "/**",
    " * Generated by scripts/sync.ts from packages/shared/src/deployments.json and",
    " * packages/shared/src/abi.ts. Do not edit: update the deployment record, then run `pnpm sync`.",
    " */",
    "",
    'import type { NetworkInfo } from "./model.js";',
    "",
    "/** Every network in the deployment record, by chain id. Addresses are lowercase. */",
    "export const NETWORKS: Readonly<Record<number, NetworkInfo>> = {",
  ];
  for (const network of networks) {
    lines.push(
      `  ${network.chainId}: {`,
      `    name: ${JSON.stringify(network.name)},`,
      `    startBlock: ${network.startBlock},`,
      `    hub: "${network.hub}",`,
      `    charger: "${network.charger}",`,
      `    forwarder: "${network.forwarder}",`,
      `    simulationForwarder: "${network.simulationForwarder}",`,
      "    assets: {",
      ...network.assets.map(([address, symbol]) => `      "${address}": ${JSON.stringify(symbol)},`),
      "    },",
      `    rpcUrl: "${network.rpc}",`,
      "  },",
    );
  }
  lines.push(
    "};",
    "",
    "/** Revert selectors a batch charge can report, with the error each one is. */",
    "export const REVERT_REASONS: Readonly<Record<string, string>> = {",
    ...errors.map(([selector, signature]) => `  "${selector}": ${JSON.stringify(signature)},`),
    "};",
  );
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const check = process.argv.includes("--check");
  if (!existsSync(deploymentsPath)) fail(`${deploymentsPath} is missing`);
  if (!existsSync(abiPath)) fail(`${abiPath} is missing`);

  const deployments = JSON.parse(readFileSync(deploymentsPath, "utf8")) as DeploymentRecord;
  const abiSource = readFileSync(abiPath, "utf8");
  const abis = CONTRACTS.map((contract) => {
    const abi = readAbi(abiSource, contract.abiExport);
    checkEvents(contract, abi);
    return abi;
  });
  const networks = networksOf(deployments);

  const outputs = new Map<string, string>([
    ["config.yaml", renderConfig(networks)],
    ["src/networks.ts", renderNetworks(networks, errorSelectors(abis))],
    ...CONTRACTS.map((contract, index): [string, string] => [`abis/${contract.name}.json`, `${JSON.stringify(abis[index], null, 2)}\n`]),
  ]);

  const stale: string[] = [];
  for (const [path, content] of outputs) {
    const target = `${projectDir}${path}`;
    const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
    if (current === content) continue;
    stale.push(path);
    if (!check) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }

  const where = relative(process.cwd(), projectDir) || ".";
  if (check && stale.length > 0) fail(`out of date in ${where}: ${stale.join(", ")}. Run \`pnpm sync\`.`);
  const summary = networks.map((n) => `${n.name} (${n.chainId}) from block ${n.startBlock}, hub ${n.hub}`).join("; ");
  console.log(check ? `sync: up to date with ${summary}` : `sync: ${stale.length === 0 ? "nothing to change" : `wrote ${stale.join(", ")}`} for ${summary}`);
}

main();
