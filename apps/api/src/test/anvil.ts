/**
 * A local anvil node with the real contracts deployed from Foundry's `out/` artifacts.
 *
 * The compiled artifacts rather than hand-written fragments, for the same reason the shared ABIs
 * are generated: a contract that drifted from its ABI deploys fine and then decodes nonsense. When
 * the artifacts are missing, `forge build` runs once first.
 *
 * Accounts come from anvil's documented development mnemonic, so no key from `.env` is ever read.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { anvil } from "viem/chains";

import { MULTICALL3_ADDRESS, type Deployment } from "@weir/shared";

import type { ApiDeployment } from "../network.js";

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export const anvilAvailable = (): boolean => spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;

export const anvilAccount = (index: number): HDAccount => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });

export async function freePort(): Promise<number> {
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

interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

function artifactPath(contract: string): string {
  return `${ROOT}out/${contract}.sol/${contract}.json`;
}

function loadArtifact(contract: string): Artifact {
  const parsed = JSON.parse(readFileSync(artifactPath(contract), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

function ensureArtifacts(contracts: readonly string[]): void {
  if (contracts.every((contract) => existsSync(artifactPath(contract)))) return;
  const build = spawnSync("forge", ["build"], { cwd: ROOT, stdio: "ignore", timeout: 600_000 });
  if (build.status !== 0) throw new Error("forge build failed; the anvil suite needs the contracts compiled");
}

export interface AnvilNode {
  rpcUrl: string;
  publicClient: PublicClient;
  stop(): Promise<void>;
}

/**
 * A fresh local node, or with `forkUrl` a fork of that network at its latest block: every contract
 * and balance on it, read lazily over the network, with Anvil's funded development accounts added.
 */
export async function startAnvil(options: { forkUrl?: string } = {}): Promise<AnvilNode> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const fork = options.forkUrl === undefined ? [] : ["--fork-url", options.forkUrl];
  const node: ChildProcess = spawn("anvil", ["--port", String(port), "--silent", ...fork], { stdio: "ignore" });
  // `cacheTime: 0`: the suite mines faster than viem's default block-number cache refreshes.
  const publicClient = createPublicClient({ chain: anvil, transport: http(rpcUrl), cacheTime: 0, pollingInterval: 50 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await publicClient.getBlockNumber();
      break;
    } catch (error) {
      // A fork reads its starting block over the network first, so it may take longer to answer.
      if (attempt > (options.forkUrl === undefined ? 100 : 600)) {
        node.kill("SIGKILL");
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return {
    rpcUrl,
    publicClient,
    stop: async () => {
      if (node.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        node.once("exit", () => resolve());
        node.kill("SIGTERM");
      });
    },
  };
}

export interface WeirOnAnvil {
  deployment: ApiDeployment;
  token: Address;
  vault: Address;
  hub: Address;
  router: Address;
}

/**
 * Deploys the test token, the savings vault, the hub and the savings router, as
 * `script/Deploy.s.sol` and `script/DeploySavingsRouter.s.sol` do on Testnet.
 */
export async function deployWeir(node: AnvilNode): Promise<WeirOnAnvil> {
  ensureArtifacts(["TestStablecoin", "TestSavingsVault", "MandateHub", "SavingsRouter"]);
  const deployer = anvilAccount(0);
  const wallet = createWalletClient({ account: deployer, chain: anvil, transport: http(node.rpcUrl) });

  const deploy = async (contract: string, args: readonly unknown[]): Promise<{ address: Address; block: number }> => {
    const { abi, bytecode } = loadArtifact(contract);
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const receipt = await node.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || receipt.contractAddress === null || receipt.contractAddress === undefined) throw new Error(`${contract} did not deploy`);
    return { address: getAddress(receipt.contractAddress), block: Number(receipt.blockNumber) };
  };

  // Multicall3 at its canonical address, as every Monad network has it; the relayer bundles through
  // it. The runtime code is byte for byte what Monad Testnet serves there.
  const multicall3 = (await readFile(fileURLToPath(new URL("./multicall3.runtime.hex", import.meta.url)), "utf8")).trim() as Hex;
  await node.publicClient.request({ method: "anvil_setCode" as never, params: [MULTICALL3_ADDRESS, multicall3] as never });

  const token = await deploy("TestStablecoin", ["Test AUSD", "tAUSD"]);
  const vault = await deploy("TestSavingsVault", [token.address, "Test AUSD Savings", "stAUSD"]);
  const hub = await deploy("MandateHub", ["Weir", "1", [token.address]]);
  const router = await deploy("SavingsRouter", [[token.address], [vault.address]]);

  return {
    token: token.address,
    vault: vault.address,
    hub: hub.address,
    router: router.address,
    deployment: {
      startBlock: token.block,
      hub: hub.address,
      domainName: "Weir",
      assets: { tAUSD: token.address },
      testStablecoin: token.address,
      savings: { tAUSD: vault.address },
      router: router.address,
    },
  };
}

/**
 * Deploys this repository's hub, charger and savings router onto `node`, a fork of Monad Mainnet,
 * over the real assets, savings vaults and Chainlink forwarders the `mainnet` record names, as the
 * Mainnet deploy scripts do. What comes back is the deployment the API reads: the code about to
 * ship, against everything it will meet there.
 */
export async function deployWeirOnFork(
  node: AnvilNode,
  chain: Chain,
  mainnet: Deployment,
): Promise<{ deployment: ApiDeployment; charger: Address }> {
  ensureArtifacts(["MandateHub", "MandateCharger", "SavingsRouter"]);
  const wallet = createWalletClient({ account: anvilAccount(0), chain, transport: http(node.rpcUrl) });
  const deploy = async (contract: string, args: readonly unknown[]): Promise<{ address: Address; block: number }> => {
    const { abi, bytecode } = loadArtifact(contract);
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const receipt = await node.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || receipt.contractAddress === null || receipt.contractAddress === undefined) throw new Error(`${contract} did not deploy`);
    return { address: getAddress(receipt.contractAddress), block: Number(receipt.blockNumber) };
  };

  const symbols = Object.keys(mainnet.assets);
  const assets = symbols.map((symbol) => getAddress(mainnet.assets[symbol] as Address));
  const vaults = symbols.map((symbol) => getAddress(mainnet.savings?.[symbol] as Address));
  const hub = await deploy("MandateHub", [mainnet.eip712.name, mainnet.eip712.version, assets]);
  const charger = await deploy("MandateCharger", [hub.address, mainnet.chainlink.forwarder, mainnet.chainlink.simulationForwarder]);
  const router = await deploy("SavingsRouter", [assets, vaults]);

  return {
    charger: charger.address,
    deployment: {
      startBlock: hub.block,
      hub: hub.address,
      domainName: mainnet.eip712.name,
      assets: Object.fromEntries(symbols.map((symbol, i) => [symbol, assets[i] as Address])),
      savings: Object.fromEntries(symbols.map((symbol, i) => [symbol, vaults[i] as Address])),
      router: router.address,
    },
  };
}
