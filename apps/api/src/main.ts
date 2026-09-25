/**
 * `pnpm --filter @weir/api start`
 *
 * Starts the Weir API against the network `MONAD_CHAIN_ID` names: migrations, then the indexer and
 * the webhook dispatcher, then the HTTP server on `API_PORT`.
 *
 *   --indexer-only   index and deliver webhooks, serve no HTTP
 *   --no-indexer     serve HTTP only; another process indexes this database
 *
 * SIGINT and SIGTERM stop it gracefully: the server stops accepting, the indexer finishes its tick,
 * queued relay transactions get their receipts, and the database pool closes.
 */

import { serve } from "@hono/node-server";
import { createMonadClient, mandateHubAbi } from "@weir/shared";
import { formatEther, isAddressEqual, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { EnvioAnalytics } from "./analytics/envio.js";
import { loadApiConfig } from "./config.js";
import { connectDatabase, migrate } from "./db/database.js";
import { createHyperSyncClient } from "./indexer/sources.js";
import { createLogger, messageOf } from "./log.js";
import { monadNetwork, symbolOf } from "./network.js";
import { webPushSender } from "./push/webPush.js";
import { createApiService } from "./service.js";

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main(argv: readonly string[]): Promise<void> {
  const logger = createLogger();
  const indexerOnly = argv.includes("--indexer-only");
  const noIndexer = argv.includes("--no-indexer");
  if (indexerOnly && noIndexer) throw new Error("--indexer-only and --no-indexer contradict each other");

  const config = loadApiConfig();
  const network = monadNetwork(config.network);
  const { deployment } = network;
  logger.info("starting", {
    network: network.chain.name,
    chainId: network.chainId,
    hub: deployment.hub,
    mode: indexerOnly ? "indexer only" : noIndexer ? "http only" : "http and indexer",
  });
  for (const note of config.notes) logger.warn(note);
  if (config.devAuth) {
    logger.warn("=".repeat(72));
    logger.warn("WEIR_DEV_AUTH=1: `Authorization: Dev <address>` signs in as ANY merchant. Local use only.");
    logger.warn("=".repeat(72));
  }

  const sql = connectDatabase(config.databaseUrl);
  const applied = await migrate(sql);
  if (applied.length > 0) logger.info("migrations applied", { versions: applied.join(",") });

  const publicClient = createMonadClient(config.network);

  // The record is what the relay allowlist trusts; say so loudly if the chain disagrees with it.
  try {
    const accepted = await publicClient.readContract({ address: deployment.hub, abi: mandateHubAbi, functionName: "acceptedAssets" });
    const recorded = Object.values(deployment.assets);
    const same = accepted.length === recorded.length && accepted.every((asset) => recorded.some((r) => isAddressEqual(r, asset)));
    if (!same) logger.error("the hub's accepted assets differ from the deployment record", { onChain: accepted.join(",") });
    else logger.info("accepted assets", { assets: accepted.map((asset) => symbolOf(deployment, asset) ?? asset).join(",") });
  } catch (error) {
    logger.warn("could not read the hub's accepted assets", { error: messageOf(error) });
  }

  const relayerAccount = config.relayerKey === undefined ? undefined : privateKeyToAccount(config.relayerKey.reveal() as Hex);
  if (relayerAccount !== undefined && !indexerOnly) {
    const balance = await publicClient.getBalance({ address: relayerAccount.address }).catch(() => undefined);
    logger.info("relayer", { address: relayerAccount.address, balance: balance === undefined ? "unknown" : `${formatEther(balance)} MON` });
  }

  const hypersync =
    config.hypersync === undefined || noIndexer
      ? undefined
      : await createHyperSyncClient(config.hypersync.url, config.hypersync.token.reveal()).catch((error: unknown) => {
          logger.warn("HyperSync client failed to load; indexing from the RPC only", { error: messageOf(error) });
          return undefined;
        });

  const analytics = config.envioDatabaseUrl === undefined ? undefined : EnvioAnalytics.connect(config.envioDatabaseUrl.reveal());
  const service = createApiService({
    network,
    sql,
    publicClient,
    logger,
    ...(relayerAccount === undefined || indexerOnly ? {} : { relayerAccount }),
    ...(config.privy === undefined ? {} : { privy: config.privy }),
    devAuth: config.devAuth,
    faucetAmount: config.faucetAmount,
    allowedOrigins: config.allowedOrigins,
    ...(hypersync === undefined ? {} : { hypersync }),
    indexer: !noIndexer,
    ...(config.push === undefined ? {} : { push: { publicKey: config.push.publicKey, send: webPushSender(config.push) } }),
    ...(analytics === undefined ? {} : { analytics }),
  });
  service.start();

  const server = indexerOnly
    ? undefined
    : serve({ fetch: service.app.fetch, port: config.port }, (info) => {
        logger.info("listening", { port: info.port, origins: config.allowedOrigins.join(",") || "none" });
      });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal });
    const timer = setTimeout(() => {
      logger.error("shutdown timed out; exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    try {
      if (server !== undefined) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
        });
      }
      await service.stop();
      await analytics?.close();
      await sql.end({ timeout: 5 });
      logger.info("stopped");
      process.exit(0);
    } catch (error) {
      logger.error("shutdown failed", { error: messageOf(error) });
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`api: failed to start: ${messageOf(error)}`);
  process.exit(1);
});
