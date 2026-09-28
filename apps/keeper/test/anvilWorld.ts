/**
 * A local anvil node with the real contracts deployed from Foundry's `out/`, for the keeper's
 * integration test.
 *
 * It lives outside `src` so it is never built into the keeper: it spawns processes, installs
 * bytecode and moves the clock. Blocks are one second apart exactly
 * (`anvil_setBlockTimestampInterval`), so the amount a stream accrues between two transactions
 * is known in advance to the base unit.
 *
 * anvil does not deploy Multicall3, so its runtime code is installed at the canonical address
 * from `multicall3.runtime.hex`, which is byte for byte what Monad Testnet serves there.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TestClient,
  type TransactionReceipt,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { MULTICALL3_ADDRESS, mandateHubAbi, stablecoinAbi, type MandateTerms } from "@weir/shared";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ARTIFACTS = ["MandateHub", "MandateCharger", "TestStablecoin"] as const;

/** anvil's documented development mnemonic. A local node; nothing of value. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

/** Whether the integration test can run here, and if not, why. */
export function anvilAvailability(): { available: true } | { available: false; reason: string } {
  const anvilVersion = spawnSync("anvil", ["--version"], { encoding: "utf8" });
  if (anvilVersion.error !== undefined || anvilVersion.status !== 0) {
    return { available: false, reason: "anvil is not on PATH; install Foundry to run it" };
  }
  if (ARTIFACTS.every((name) => existsSync(artifactPath(name)))) return { available: true };

  const build = spawnSync("forge", ["build"], { cwd: ROOT, encoding: "utf8", timeout: 600_000 });
  if (build.error !== undefined || build.status !== 0) {
    return { available: false, reason: "the contracts are not built in out/ and `forge build` did not succeed" };
  }
  return { available: true };
}

function artifactPath(name: string): string {
  return `${ROOT}out/${name}.sol/${name}.json`;
}

async function artifact(name: (typeof ARTIFACTS)[number]): Promise<{ abi: Abi; bytecode: Hex }> {
  const parsed = JSON.parse(await readFile(artifactPath(name), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export interface World {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly publicClient: PublicClient;
  readonly testClient: TestClient;
  readonly hub: Address;
  readonly charger: Address;
  readonly token: Address;
  /** The block the hub was deployed in. */
  readonly startBlock: bigint;
  /** Signs the keeper's charges and nothing else. */
  readonly keeper: HDAccount;
  /** Holds tokens and has approved the hub without limit. */
  readonly payer: HDAccount;
  /** Holds nothing. */
  readonly brokePayer: HDAccount;
  /** Send a call and return its receipt, refusing a revert. */
  write(account: HDAccount, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt>;
  /** Create a mandate and return its id and the timestamp of its block. */
  createMandate(payer: HDAccount, terms: Partial<MandateTerms> & Pick<MandateTerms, "merchant" | "amount" | "period">): Promise<{ id: bigint; at: bigint }>;
  latestTimestamp(): Promise<bigint>;
  /** Mine one block `seconds` after the latest. */
  warp(seconds: bigint): Promise<void>;
  mine(blocks: number): Promise<void>;
  balanceOf(owner: Address): Promise<bigint>;
  stop(): Promise<void>;
}

export async function startWorld(): Promise<World> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const node: ChildProcess = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });

  const publicClient = createPublicClient({ chain: anvil, transport: http(rpcUrl), pollingInterval: 50, cacheTime: 0 });
  const testClient = createTestClient({ mode: "anvil", chain: anvil, transport: http(rpcUrl) });
  try {
    await waitForNode(publicClient);
  } catch (error) {
    node.kill("SIGKILL");
    throw error;
  }

  const multicall3 = (await readFile(fileURLToPath(new URL("./multicall3.runtime.hex", import.meta.url)), "utf8")).trim() as Hex;
  await testClient.setCode({ address: MULTICALL3_ADDRESS, bytecode: multicall3 });
  await testClient.setBlockTimestampInterval({ interval: 1 });

  const account = (index: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
  const deployer = account(0);
  const keeper = account(1);
  const payer = account(2);
  const brokePayer = account(3);

  const write: World["write"] = async (from, address, abi, functionName, args) => {
    const wallet = createWalletClient({ account: from, chain: anvil, transport: http(rpcUrl) });
    const hash = await wallet.writeContract({ address, abi, functionName, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
    return receipt;
  };

  const deploy = async (name: (typeof ARTIFACTS)[number], args: readonly unknown[]) => {
    const { abi, bytecode } = await artifact(name);
    const wallet = createWalletClient({ account: deployer, chain: anvil, transport: http(rpcUrl) });
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (receipt.status !== "success" || receipt.contractAddress == null) throw new Error(`deploying ${name} failed`);
    return { address: receipt.contractAddress, blockNumber: receipt.blockNumber };
  };

  const token = (await deploy("TestStablecoin", ["Test AUSD", "tAUSD"])).address;
  const hubDeployment = await deploy("MandateHub", ["Weir", "1", [token]]);
  const hub = hubDeployment.address;
  const charger = (await deploy("MandateCharger", [hub, zeroAddress, zeroAddress])).address;

  const stablecoin = stablecoinAbi as Abi;
  await write(deployer, token, stablecoin, "mint", [payer.address, 1_000_000_000n]);
  await write(payer, token, stablecoin, "approve", [hub, 2n ** 256n - 1n]);
  await write(brokePayer, token, stablecoin, "approve", [hub, 2n ** 256n - 1n]);

  const latestTimestamp = async () => (await publicClient.getBlock({ blockTag: "latest" })).timestamp;

  return {
    rpcUrl,
    chainId: anvil.id,
    publicClient,
    testClient,
    hub,
    charger,
    token,
    startBlock: hubDeployment.blockNumber,
    keeper,
    payer,
    brokePayer,
    write,
    createMandate: async (from, terms) => {
      const now = await latestTimestamp();
      const full: MandateTerms = {
        asset: token,
        vault: zeroAddress,
        manager: zeroAddress,
        startAt: 0n,
        maxPerCharge: terms.amount,
        maxTotal: terms.amount * 1_000n,
        expiresAt: now + 86_400n,
        ref: `0x${"00".repeat(32)}`,
        ...terms,
      };
      const receipt = await write(from, hub, mandateHubAbi as Abi, "createMandate", [full]);
      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      const id = (await publicClient.readContract({ address: hub, abi: mandateHubAbi, functionName: "nextMandateId" })) - 1n;
      return { id, at: block.timestamp };
    },
    latestTimestamp,
    warp: async (seconds) => {
      await testClient.setNextBlockTimestamp({ timestamp: (await latestTimestamp()) + seconds });
      await testClient.mine({ blocks: 1 });
    },
    mine: (blocks) => testClient.mine({ blocks }),
    balanceOf: (owner) => publicClient.readContract({ address: token, abi: stablecoinAbi, functionName: "balanceOf", args: [owner] }),
    stop: async () => {
      node.kill("SIGKILL");
    },
  };
}

async function waitForNode(client: PublicClient): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.getChainId();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("anvil did not start within five seconds");
}
