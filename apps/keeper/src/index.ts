/**
 * The keeper process: a pass every KEEPER_INTERVAL_MS with a small HTTP server beside it, or one
 * pass with `--once`.
 *
 *   pnpm keeper                           # from the repository root
 *   pnpm --filter @weir/keeper start      # the same, from the package
 *   pnpm --filter @weir/keeper once       # one pass; exits 1 when it could not finish
 *
 * One signer, one process. Charges are sent one transaction at a time with each receipt
 * awaited; a second keeper on the same key would race it for nonces, so run a second keeper
 * only on a second key. Passes never overlap: the next one is scheduled when the last ends.
 *
 * SIGINT or SIGTERM lets the pass in progress finish, closes the server, flushes the cursor and
 * exits 0. A second signal exits at once.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, formatEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { explorerUrl, monadTransport, MULTICALL3_ADDRESS, networkFor, type EnvSource } from "@weir/shared";
import { createChargeTransport } from "./charge.js";
import { loadKeeperConfig, type HyperSyncConfig, type KeeperConfig } from "./config.js";
import { describeCursor, MandateCursor } from "./discover.js";
import { createHyperSyncClient, createHyperSyncReader, createRpcReader, HistorySource } from "./history.js";
import { Keeper, summarizePass } from "./keeper.js";
import { createConsoleLogger, describeError, type Logger } from "./log.js";
import { startServer } from "./server.js";

export const USAGE = `Usage: keeper [--once]

  --once   Run one pass and exit: 0 when it finished, 1 when it could not.
  --help   Show this text.

Reads its configuration from the environment; see .env.example.`;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export function parseArgs(argv: readonly string[]): { once: boolean; help: boolean } | string {
  let once = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--once") once = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else return `unknown argument ${arg}`;
  }
  return { once, help };
}

/** Build the keeper from its configuration. The key is revealed here once, to make the account. */
export async function createKeeper(config: KeeperConfig, log: Logger): Promise<Keeper> {
  const { network, deployment } = config;
  const chain = networkFor(network.chainId).chain;
  const account = privateKeyToAccount(config.signer.reveal() as Hex);
  const publicClient = createPublicClient({ chain, transport: monadTransport(network) });
  const walletClient = createWalletClient({ account, chain, transport: monadTransport(network) });

  const hub = deployment.contracts.MandateHub;
  const charger = deployment.contracts.MandateCharger;
  const startBlock = BigInt(deployment.startBlock);

  const archive = config.hypersync === undefined ? undefined : await openArchive(config.hypersync, hub, log);
  const history = new HistorySource({
    rpc: createRpcReader(publicClient, hub, config.logChunkBlocks),
    rpcChunkBlocks: config.logChunkBlocks,
    archive,
    chainId: network.chainId,
    log,
  });

  const cursor = await MandateCursor.open(config.cursorPath, { chainId: network.chainId, hub, startBlock });
  const balance = await publicClient.getBalance({ address: account.address });

  log.info(`Weir keeper on ${deployment.network} (chain ${network.chainId})`);
  log.info(`hub ${hub}, charger ${charger}, keeper ${account.address} holding ${formatEther(balance)} MON`);
  log.info(`history from ${history.describe}; ${describeCursor(cursor)}`);
  log.info(
    `a pass every ${config.intervalMs} ms, batches of ${config.batchSize}; streams charged at ` +
      `${config.streamMinCharge} base units or ${config.streamMaxAgeSeconds} s since their checkpoint`,
  );
  if (balance === 0n) log.warn(`the keeper holds no MON and cannot pay for a charge`);

  return new Keeper({
    chainId: network.chainId,
    publicClient,
    transport: createChargeTransport({ publicClient, walletClient, charger }),
    keeper: account.address,
    hub,
    charger,
    multicall: MULTICALL3_ADDRESS,
    history,
    cursor,
    policy: {
      streamMinCharge: config.streamMinCharge,
      streamMaxAgeSeconds: config.streamMaxAgeSeconds,
      intervalSeconds: BigInt(Math.ceil(config.intervalMs / 1000)),
    },
    batchSize: config.batchSize,
    gas: config.gas,
    assets: deployment.assets,
    explorer: (hash) => explorerUrl(network.chainId, "tx", hash),
    log,
  });
}

/** The HyperSync client, or `undefined` with a warning when its native module cannot load here. */
async function openArchive(hypersync: HyperSyncConfig, hub: Address, log: Logger) {
  try {
    const client = await createHyperSyncClient(hypersync.url, hypersync.token);
    return { client, reader: createHyperSyncReader(client, hub) };
  } catch (error) {
    log.warn(`HyperSync is configured but its client did not load (${describeError(error)}); reading history from the RPC`);
    return undefined;
  }
}

export async function main(argv: readonly string[], env: EnvSource = process.env, log: Logger = createConsoleLogger()): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(`${args}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (args.help) {
    console.log(USAGE);
    return EXIT_OK;
  }

  let config: KeeperConfig;
  let keeper: Keeper;
  try {
    config = loadKeeperConfig(env);
    keeper = await createKeeper(config, log);
  } catch (error) {
    log.error(`the keeper could not start: ${describeError(error)}`);
    return EXIT_FAILED;
  }

  if (args.once) {
    const result = await keeper.runPass();
    log.info(summarizePass(result));
    await keeper.cursor.settle();
    return result.ok ? EXIT_OK : EXIT_FAILED;
  }

  const server = await startServer({ host: config.host, port: config.port, keeper, log });
  log.info(`serving /health and /due on ${server.url}`);

  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (signal: string) => {
    if (stopping) {
      log.warn(`${signal} again; exiting now`);
      process.exit(EXIT_FAILED);
    }
    stopping = true;
    log.info(`${signal}; stopping after the pass in progress`);
    wake?.();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!stopping) {
    const result = await keeper.runPass();
    log.info(summarizePass(result));
    if (stopping) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.intervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = undefined;
  }

  await keeper.idle();
  await server.close();
  await keeper.cursor.settle();
  log.info("stopped");
  return EXIT_OK;
}

/** True when this file is the process entry point, under node or tsx, and not when imported. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

/**
 * Exit with `code` once output has drained. The exit code is set rather than forced, so buffered
 * lines reach a pipe; the unreferenced timer only ends a process something else keeps alive.
 */
function exitWith(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(exitWith, (error: unknown) => {
    console.error(describeError(error));
    exitWith(EXIT_FAILED);
  });
}
