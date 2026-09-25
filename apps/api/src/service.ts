/**
 * The API as one object: the Hono app, the relayer, the indexer and the webhook dispatcher, wired
 * from already-open resources.
 *
 * `main.ts` builds those resources from the environment; the integration test builds them for a
 * local node. Nothing in here reads `process.env`.
 */

import { mandateHubAbi, MULTICALL3_ADDRESS, stablecoinAbi } from "@weir/shared";
import type { Hono } from "hono";
import { parseAbi, zeroAddress, type Address, type LocalAccount, type PublicClient } from "viem";

import { ping, type Sql } from "./db/database.js";
import { Store } from "./db/store.js";
import { createApp, type HealthResponse, type RateLimits, type SavingsVaultInfo } from "./http/app.js";
import { createMerchantAuth, type TokenVerifier } from "./http/auth.js";
import { Indexer, type IndexerOptions } from "./indexer/indexer.js";
import { createMandateReader } from "./indexer/reader.js";
import { HyperSyncLogSource, RpcLogSource, type HyperSyncQueryClient } from "./indexer/sources.js";
import { messageOf, type Logger } from "./log.js";
import { displaySymbol, permitTokens, savingsVaultFor, type ApiNetwork } from "./network.js";
import type { EnvioAnalytics } from "./analytics/envio.js";
import { Relayer } from "./relay/relayer.js";
import { RelayService, type StreamReader } from "./relay/service.js";
import { createViemRelayChain } from "./relay/viemChain.js";
import { ReminderWorker } from "./push/reminders.js";
import type { PushSender } from "./push/sender.js";
import { WebhookDispatcher, type DispatcherOptions } from "./webhooks/dispatcher.js";

/** The simulated rate `TestSavingsVault` earns, `RATE_BPS` in the contract. */
export const TEST_SAVINGS_APY_BPS = 500;

const erc4626Abi = parseAbi(["function asset() view returns (address)"]);

export interface ApiServiceOptions {
  network: ApiNetwork;
  sql: Sql;
  publicClient: PublicClient;
  logger: Logger;
  /** The relayer's account; without one the relay and the faucet answer 503. */
  relayerAccount?: LocalAccount;
  privy?: { appId: string; appSecret: { reveal(): string } };
  /** Injected in tests in place of Privy. */
  tokenVerifier?: TokenVerifier;
  devAuth: boolean;
  faucetAmount: bigint;
  allowedOrigins: readonly string[];
  hypersync?: HyperSyncQueryClient;
  /** Run the indexer and the webhook dispatcher in this process. */
  indexer: boolean;
  indexerOptions?: Partial<Pick<IndexerOptions, "reorgWindowBlocks" | "liveWindowBlocks" | "pollMs" | "hypersyncChunkBlocks">>;
  webhookOptions?: Partial<Pick<DispatcherOptions, "backoffMs" | "pollMs" | "timeoutMs" | "fetch">>;
  limits?: RateLimits;
  clientIp?: Parameters<typeof createApp>[0]["clientIp"];
  receiptTimeoutMs?: number;
  /** Analytics from the Envio HyperIndex database. */
  analytics?: EnvioAnalytics;
  /** Push reminders: the VAPID public key browsers subscribe with, and the sender. */
  push?: { publicKey: string; send: PushSender; pollMs?: number };
}

export interface ApiService {
  app: Hono;
  store: Store;
  relay?: RelayService;
  indexer?: Indexer;
  dispatcher?: WebhookDispatcher;
  reminders?: ReminderWorker;
  start(): void;
  /** Stops the indexer and the dispatcher and lets queued transactions finish. */
  stop(): Promise<void>;
}

export function createApiService(options: ApiServiceOptions): ApiService {
  const { network, sql, publicClient, logger } = options;
  const { deployment } = network;
  const scope = { chainId: network.chainId, hub: deployment.hub };
  const symbolFor = (asset: Address): string => displaySymbol(deployment, asset);
  const store = new Store(sql, scope, symbolFor);

  let relay: RelayService | undefined;
  if (options.relayerAccount !== undefined) {
    const chain = createViemRelayChain({
      publicClient,
      account: options.relayerAccount,
      chain: network.chain,
      rpcUrl: network.rpcUrl,
      ...(options.receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs: options.receiptTimeoutMs }),
    });
    const faucet =
      !network.mainnet && deployment.testStablecoin !== undefined
        ? { token: deployment.testStablecoin, maxAmount: options.faucetAmount }
        : undefined;
    // Multicall3 sits at its canonical address on every Monad network; bundling through it makes
    // an install one transaction.
    const policy = {
      hub: deployment.hub,
      multicall: MULTICALL3_ADDRESS,
      permitTokens: permitTokens(deployment),
      ...(faucet === undefined ? {} : { faucet }),
      ...(deployment.router === undefined ? {} : { router: deployment.router }),
      payouts: { relayer: options.relayerAccount.address, assets: Object.values(deployment.assets) },
    };
    const relayer = new Relayer(chain, policy, logger);
    const streams: StreamReader = async (mandateId) => {
      const [mandate, quote] = await Promise.all([
        publicClient.readContract({ address: deployment.hub, abi: mandateHubAbi, functionName: "getMandate", args: [mandateId] }),
        publicClient.readContract({ address: deployment.hub, abi: mandateHubAbi, functionName: "quoteCharge", args: [mandateId] }),
      ]);
      return { streaming: mandate.period === 0, paused: mandate.pausedAt !== 0n, fromVault: mandate.vault !== zeroAddress, quote };
    };
    // A Testnet vault's withdrawal costs far less than a Morpho vault's on Mainnet.
    relay = new RelayService(relayer, chain, deployment, logger, streams, network.mainnet ? 500_000n : 200_000n);
  }

  let indexer: Indexer | undefined;
  let dispatcher: WebhookDispatcher | undefined;
  if (options.indexer) {
    indexer = new Indexer({
      sql,
      scope,
      startBlock: deployment.startBlock,
      rpc: new RpcLogSource(publicClient, deployment.hub, network.logChunkBlocks),
      ...(options.hypersync === undefined ? {} : { hypersync: new HyperSyncLogSource(options.hypersync, deployment.hub) }),
      reader: createMandateReader(publicClient, deployment.hub),
      symbolFor,
      logger,
      ...options.indexerOptions,
    });
    dispatcher = new WebhookDispatcher({ sql, logger, ...options.webhookOptions });
  }
  // Reminders read the index, so they run where the indexer does.
  const reminders =
    options.indexer && options.push !== undefined
      ? new ReminderWorker({
          store,
          send: options.push.send,
          logger,
          ...(options.push.pollMs === undefined ? {} : { pollMs: options.push.pollMs }),
        })
      : undefined;

  // Each vault's name and symbol are read once; a failed read is retried on the next checkout.
  // Only the Testnet vault's rate is known here, since it is fixed in its code.
  const vaults = new Map<Address, Promise<SavingsVaultInfo>>();
  const savingsVault = (asset: Address): Promise<SavingsVaultInfo | undefined> => {
    const address = savingsVaultFor(deployment, asset);
    if (address === undefined) return Promise.resolve(undefined);
    let info = vaults.get(address);
    if (info === undefined) {
      info = (async () => {
        const [name, symbol, vaultAsset] = await Promise.all([
          publicClient.readContract({ address, abi: stablecoinAbi, functionName: "name" }),
          publicClient.readContract({ address, abi: stablecoinAbi, functionName: "symbol" }),
          publicClient.readContract({ address, abi: erc4626Abi, functionName: "asset" }),
        ]);
        return { address, name, symbol, asset: vaultAsset, ...(network.mainnet ? {} : { apyBps: TEST_SAVINGS_APY_BPS }) };
      })();
      info.catch(() => vaults.delete(address));
      vaults.set(address, info);
    }
    return info;
  };

  let headCache: { at: number; head: number } | undefined;
  const health = async (): Promise<HealthResponse> => {
    const database = await ping(sql);
    const status = indexer?.status;
    let head = status?.head;
    let indexedBlock = status?.indexedBlock;
    if (indexer === undefined) {
      // No indexer here: report the one writing this database, from its cursor and the chain.
      try {
        if (headCache === undefined || Date.now() - headCache.at > 2_000) {
          headCache = { at: Date.now(), head: Number(await publicClient.getBlockNumber({ cacheTime: 0 })) };
        }
        head = headCache.head;
      } catch (error) {
        logger.warn("health could not read the head", { error: messageOf(error) });
      }
      indexedBlock = database ? await store.indexedBlock().catch(() => undefined) : undefined;
    }
    const lag = head !== undefined && indexedBlock !== undefined ? Math.max(0, head - indexedBlock) : undefined;
    return {
      ok: database && lag !== undefined && lag <= 50 && status?.lastError === undefined,
      chainId: network.chainId,
      hub: deployment.hub,
      database,
      indexer: {
        running: status?.running ?? false,
        standingBy: status?.standingBy ?? false,
        head: head ?? null,
        indexedBlock: indexedBlock ?? null,
        lag: lag ?? null,
        caughtUp: lag !== undefined && lag === 0,
        lastTickAt: status?.lastTickAt ?? null,
        source: status?.source ?? null,
        ...(status?.lastError === undefined ? {} : { lastError: status.lastError }),
      },
      relayer:
        relay === undefined ? { configured: false } : { configured: true, address: relay.address, queueDepth: relay.queueDepth },
    };
  };

  const app = createApp({
    network,
    store,
    ...(relay === undefined ? {} : { relay }),
    auth: createMerchantAuth({
      devAuth: options.devAuth,
      logger,
      ...(options.privy === undefined ? {} : { privy: options.privy }),
      ...(options.tokenVerifier === undefined ? {} : { verifier: options.tokenVerifier }),
    }),
    logger,
    allowedOrigins: options.allowedOrigins,
    health,
    savingsVault,
    verifySignature: (args) => publicClient.verifyTypedData(args),
    ...(options.push === undefined ? {} : { pushPublicKey: options.push.publicKey }),
    ...(options.analytics === undefined ? {} : { analytics: options.analytics }),
    faucetAmount: options.faucetAmount,
    webhookPolicy: { requireHttps: network.mainnet, allowPrivateHosts: options.devAuth && !network.mainnet },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.clientIp === undefined ? {} : { clientIp: options.clientIp }),
  });

  return {
    app,
    store,
    ...(relay === undefined ? {} : { relay }),
    ...(indexer === undefined ? {} : { indexer }),
    ...(dispatcher === undefined ? {} : { dispatcher }),
    ...(reminders === undefined ? {} : { reminders }),
    start() {
      indexer?.start();
      dispatcher?.start();
      reminders?.start();
    },
    async stop() {
      await Promise.all([indexer?.stop(), dispatcher?.stop(), reminders?.stop()]);
      await relay?.drain();
    },
  };
}
