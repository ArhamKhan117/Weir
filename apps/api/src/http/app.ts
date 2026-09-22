/**
 * The HTTP surface: every route in `API_ROUTES`, with CORS, a body limit, request logging and one
 * error format.
 *
 * Handlers are thin. They read the request with the strict readers in `validate.ts`, call the
 * store or the relay service, and return the wire types from `@weir/shared`. Every failure is an
 * {@link ApiHttpError} or becomes a bare `internal`, logged here and never echoed.
 */

import {
  API_ROUTES,
  pushSubscriptionTypedData,
  supportCircleTypedData,
  supporterNameTypedData,
  type CheckoutResponse,
  type MerchantOverview,
  type MerchantProfile,
  type PayerResponse,
  type MerchantAnalytics,
  type PayoutInfo,
  type StatsResponse,
  type PayoutResponse,
  type Plan,
  type PushKeyResponse,
  type SavingsResponse,
  type SupportCircle,
  type SupportListResponse,
  type SupportResponse,
} from "@weir/shared";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { isAddressEqual, zeroAddress, type Address, type VerifyTypedDataParameters } from "viem";

import type { EnvioAnalytics } from "../analytics/envio.js";
import type { Store } from "../db/store.js";
import { newPlanId, newSupportId, PLAN_ID_PATTERN, SUPPORT_ID_PATTERN } from "../domain/ids.js";
import { validatePlan } from "../domain/plans.js";
import { readPushEndpoint, validatePushSubscription } from "../domain/push.js";
import { validateSupport, validateSupporterName } from "../domain/support.js";
import { merchantStats, THIRTY_DAYS } from "../domain/stats.js";
import { toMerchantProfile, type MerchantRow } from "../domain/views.js";
import { messageOf, type Logger } from "../log.js";
import { symbolOf, type ApiNetwork } from "../network.js";
import { RelayPolicyError } from "../relay/policy.js";
import { ReceiptTimeoutError, RejectedOnChainError } from "../relay/relayer.js";
import { parseAction, parseInstall, parsePayout, parseSavings, parseSetManager } from "../relay/requests.js";
import type { RelayService } from "../relay/service.js";
import { validateWebhookUrl, type WebhookUrlPolicy } from "../webhooks/url.js";
import type { MerchantAuth, MerchantIdentity } from "./auth.js";
import {
  ApiHttpError,
  badRequest,
  internal,
  notConfigured,
  notFound,
  rateLimited,
  rejectedOnChain,
} from "./errors.js";
import { FAUCET_ADDRESS_COOLDOWN_SECONDS, RATE_LIMITS, RateLimiter } from "./ratelimit.js";
import { field, MAX_UINT256, optionalField, readAddress, readBoolean, readObject, readText, readUnits } from "./validate.js";

/** `GET /health`. */
export interface HealthResponse {
  ok: boolean;
  chainId: number;
  hub: Address;
  database: boolean;
  indexer: {
    running: boolean;
    standingBy: boolean;
    head: number | null;
    indexedBlock: number | null;
    lag: number | null;
    caughtUp: boolean;
    lastTickAt: number | null;
    source: "rpc" | "hypersync" | null;
    lastError?: string;
  };
  relayer: { configured: boolean; address?: Address; queueDepth?: number };
}

/** `PUT /v1/merchant`: the profile, and the webhook secret the one time it is revealed. */
export type UpdateMerchantResponse = MerchantProfile & { webhookSecret?: string };

/** `GET /v1/merchant/plans`. */
export interface PlanListResponse {
  plans: Plan[];
}

export interface SavingsVaultInfo {
  address: Address;
  name: string;
  symbol: string;
  asset: Address;
  /** Known only for the Testnet vault, whose rate is fixed in its code. */
  apyBps?: number;
}

export interface RateLimits {
  relayPerIp: RateLimiter;
  installPerPayer: RateLimiter;
  savingsPerOwner: RateLimiter;
  payoutsPerMerchant: RateLimiter;
  faucetPerIp: RateLimiter;
}

export function createRateLimits(now?: () => number): RateLimits {
  return {
    relayPerIp: new RateLimiter({ ...RATE_LIMITS.relayPerIp, ...(now === undefined ? {} : { now }) }),
    installPerPayer: new RateLimiter({ ...RATE_LIMITS.installPerPayer, ...(now === undefined ? {} : { now }) }),
    savingsPerOwner: new RateLimiter({ ...RATE_LIMITS.savingsPerOwner, ...(now === undefined ? {} : { now }) }),
    payoutsPerMerchant: new RateLimiter({ ...RATE_LIMITS.payoutsPerMerchant, ...(now === undefined ? {} : { now }) }),
    faucetPerIp: new RateLimiter({ ...RATE_LIMITS.faucetPerIp, ...(now === undefined ? {} : { now }) }),
  };
}

export interface AppDeps {
  network: ApiNetwork;
  store: Store;
  relay?: RelayService;
  auth: MerchantAuth;
  logger: Logger;
  allowedOrigins: readonly string[];
  health: () => Promise<HealthResponse>;
  /** The savings vault offered for `asset`, when it has one. */
  savingsVault: (asset: Address) => Promise<SavingsVaultInfo | undefined>;
  /**
   * Whether `address` signed the typed data: by ECDSA for an account with no code, by ERC-1271 for
   * a smart account. Built from the chain client, since only the chain knows which one an
   * address is.
   */
  verifySignature: (args: VerifyTypedDataParameters) => Promise<boolean>;
  /** The VAPID public key browsers subscribe to reminders with; absent when reminders are off. */
  pushPublicKey?: string;
  /** Analytics from the Envio HyperIndex database; absent when it is not configured. */
  analytics?: EnvioAnalytics;
  faucetAmount: bigint;
  webhookPolicy: WebhookUrlPolicy;
  limits?: RateLimits;
  /** The client's address for rate limits. Defaults to the socket's remote address. */
  clientIp?: (c: Context) => string;
  /** Milliseconds. */
  now?: () => number;
}

/** The socket's peer. Forwarded headers are not trusted: anyone can send them. */
function socketIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest("The body must be JSON");
  }
}

function relayError(error: unknown): never {
  if (error instanceof ApiHttpError) throw error;
  if (error instanceof RejectedOnChainError) throw rejectedOnChain(error.message);
  if (error instanceof RelayPolicyError) throw badRequest(error.message);
  if (error instanceof ReceiptTimeoutError) {
    throw new ApiHttpError(504, "internal", `${error.message}; check it on the explorer before retrying`);
  }
  throw error;
}

export function createApp(deps: AppDeps): Hono {
  const { network, store, logger } = deps;
  const { deployment } = network;
  const now = deps.now ?? Date.now;
  const nowSeconds = (): number => Math.floor(now() / 1000);
  const clientIp = deps.clientIp ?? socketIp;
  const limits = deps.limits ?? createRateLimits(now);
  const symbolFor = (asset: Address): string | undefined => symbolOf(deployment, asset);
  const faucetInFlight = new Set<string>();

  const app = new Hono();

  app.use("*", async (c, next) => {
    const started = now();
    await next();
    logger.info(`${c.req.method} ${c.req.path}`, { status: c.res.status, ms: now() - started });
  });

  app.use(
    "*",
    cors({
      origin: (origin) => (deps.allowedOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["Retry-After"],
      maxAge: 600,
    }),
  );

  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: () => {
        throw new ApiHttpError(413, "bad_request", "The body is larger than 64 KiB");
      },
    }),
  );

  app.onError((error, c) => {
    if (error instanceof ApiHttpError) {
      for (const [name, value] of Object.entries(error.headers)) c.header(name, value);
      return c.json(error.body(), error.status);
    }
    logger.error("unhandled error", { method: c.req.method, path: c.req.path, error: messageOf(error) });
    return c.json(internal().body(), 500);
  });

  app.notFound((c) => c.json(notFound(`No route ${c.req.method} ${c.req.path}`).body(), 404));

  const limit = (limiter: RateLimiter, key: string, what: string): void => {
    const decision = limiter.take(key);
    if (!decision.ok) throw rateLimited(`Too many ${what}; try again shortly`, decision.retryAfterSeconds);
  };

  const requireRelay = (): RelayService => {
    if (deps.relay === undefined) throw notConfigured("The relayer is not configured on this server");
    return deps.relay;
  };

  /*//////////////////////////////////////////////////////////////
                                PUBLIC
  //////////////////////////////////////////////////////////////*/

  /** Every network's totals and last 30 days, from Envio HyperIndex: public, as the chain is. */
  let statsCache: { at: number; body: StatsResponse } | undefined;
  app.get(API_ROUTES.stats, async (c) => {
    if (deps.analytics === undefined) throw notConfigured("Analytics are not configured on this server");
    if (statsCache === undefined || now() - statsCache.at > 15_000) {
      statsCache = { at: now(), body: { networks: await deps.analytics.networks(nowSeconds()) } };
    }
    c.header("cache-control", "public, max-age=15");
    return c.json(statsCache.body);
  });

  app.get(API_ROUTES.health, async (c) => {
    const health = await deps.health();
    return c.json(health, health.database ? 200 : 503);
  });

  app.get("/v1/checkout/:planId", async (c) => {
    const planId = c.req.param("planId");
    const plan = PLAN_ID_PATTERN.test(planId) ? await store.getPlan(planId) : undefined;
    if (plan === undefined) throw notFound(`No plan ${planId}`);

    const response: CheckoutResponse = {
      plan,
      chainId: network.chainId,
      hub: deployment.hub,
      domainName: deployment.domainName,
    };
    try {
      const vault = await deps.savingsVault(plan.asset);
      if (vault !== undefined && isAddressEqual(vault.asset, plan.asset)) {
        response.savingsVault = {
          address: vault.address,
          name: vault.name,
          symbol: vault.symbol,
          ...(vault.apyBps === undefined ? {} : { apyBps: vault.apyBps }),
        };
      }
    } catch (error) {
      logger.warn("savings vault unreadable; checkout served without it", { error: messageOf(error) });
    }
    return c.json(response);
  });

  app.get("/v1/payers/:address", async (c) => {
    const payer = readAddress(c.req.param("address"), "address");
    const body: PayerResponse = {
      mandates: await store.mandates({ payer }, nowSeconds(), 200),
      charges: await store.charges({ payer }, 50),
    };
    return c.json(body);
  });

  /*//////////////////////////////////////////////////////////////
                                RELAY
  //////////////////////////////////////////////////////////////*/

  app.post(API_ROUTES.install, async (c) => {
    limit(limits.relayPerIp, clientIp(c), "relay requests from this client");
    const input = parseInstall(await readJson(c), nowSeconds());
    const relay = requireRelay();
    try {
      // Counted only once the payer's own signature has simulated, so nobody can spend a payer's
      // allowance of installs by sending garbage in their name.
      return c.json(await relay.install(input, () => limit(limits.installPerPayer, input.payer, "installs for this payer")));
    } catch (error) {
      relayError(error);
    }
  });

  app.post(API_ROUTES.action, async (c) => {
    limit(limits.relayPerIp, clientIp(c), "relay requests from this client");
    const input = parseAction(await readJson(c), nowSeconds());
    const relay = requireRelay();
    try {
      return c.json(await relay.action(input));
    } catch (error) {
      relayError(error);
    }
  });

  app.post(API_ROUTES.setManager, async (c) => {
    limit(limits.relayPerIp, clientIp(c), "relay requests from this client");
    const input = parseSetManager(await readJson(c), nowSeconds());
    const relay = requireRelay();
    try {
      return c.json(await relay.setManager(input));
    } catch (error) {
      relayError(error);
    }
  });

  app.get(API_ROUTES.savingsVaults, async (c) => {
    const vaults = await Promise.all(
      Object.entries(deployment.assets).map(async ([assetSymbol, asset]) => {
        try {
          const vault = await deps.savingsVault(asset);
          return vault === undefined || !isAddressEqual(vault.asset, asset)
            ? undefined
            : {
                asset,
                assetSymbol,
                address: vault.address,
                name: vault.name,
                symbol: vault.symbol,
                ...(vault.apyBps === undefined ? {} : { apyBps: vault.apyBps }),
              };
        } catch (error) {
          logger.warn("savings vault unreadable; listed without it", { asset, error: messageOf(error) });
          return undefined;
        }
      }),
    );
    const response: SavingsResponse = {
      ...(deployment.router === undefined ? {} : { router: deployment.router }),
      vaults: vaults.filter((vault) => vault !== undefined),
    };
    return c.json(response);
  });

  /*//////////////////////////////////////////////////////////////
                            FAMILY SUPPORT
  //////////////////////////////////////////////////////////////*/

  const signedBy = async (args: VerifyTypedDataParameters): Promise<boolean> => {
    try {
      return await deps.verifySignature(args);
    } catch (error) {
      logger.warn("signature check failed", { error: messageOf(error) });
      return false;
    }
  };

  const supportOr404 = async (id: string): Promise<SupportCircle> => {
    const circle = SUPPORT_ID_PATTERN.test(id) ? await store.getSupport(id) : undefined;
    if (circle === undefined) throw notFound(`No support circle ${id}`);
    return circle;
  };

  app.post(API_ROUTES.support, async (c) => {
    limit(limits.relayPerIp, clientIp(c), "requests from this client");
    const support = validateSupport(await readJson(c), nowSeconds(), symbolFor);
    const signed = await signedBy({
      address: support.recipient,
      ...supportCircleTypedData({
        chainId: network.chainId,
        recipient: support.recipient,
        name: support.name,
        note: support.note,
        currency: support.currency,
        asset: support.asset,
        period: support.period,
        goal: support.goal,
        nonce: support.nonce,
        deadline: BigInt(support.deadline),
      }),
      signature: support.signature,
    });
    if (!signed) throw badRequest("The signature is not the recipient's: only the person supported can open their circle");
    return c.json(await store.insertSupport(newSupportId(), support, nowSeconds()), 201);
  });

  app.get("/v1/support/:id", async (c) => {
    const circle = await supportOr404(c.req.param("id"));
    const [supporters, received] = await Promise.all([store.supporters(circle, nowSeconds()), store.supportReceived(circle)]);
    // A past-due supporter still means to give, and is retried; only a stopped one has left.
    // A single contribution ("send now") is counted in what arrived, never in what comes each period.
    const committed = supporters
      .filter((supporter) => !supporter.once && (supporter.standing === "Active" || supporter.standing === "Past due"))
      .reduce((sum, supporter) => sum + BigInt(supporter.amount), 0n);
    const response: SupportResponse = {
      circle,
      chainId: network.chainId,
      hub: deployment.hub,
      domainName: deployment.domainName,
      supporters,
      committedPerPeriod: committed.toString(),
      received,
    };
    try {
      const vault = await deps.savingsVault(circle.asset);
      if (vault !== undefined && isAddressEqual(vault.asset, circle.asset)) {
        response.savingsVault = {
          address: vault.address,
          name: vault.name,
          symbol: vault.symbol,
          ...(vault.apyBps === undefined ? {} : { apyBps: vault.apyBps }),
        };
      }
    } catch (error) {
      logger.warn("savings vault unreadable; support served without it", { error: messageOf(error) });
    }
    return c.json(response);
  });

  app.get("/v1/recipients/:address/support", async (c) => {
    const recipient = readAddress(c.req.param("address"), "address");
    const response: SupportListResponse = { circles: await store.supportFor(recipient) };
    return c.json(response);
  });

  app.put("/v1/support/:id/supporters/:mandateId/name", async (c) => {
    limit(limits.relayPerIp, clientIp(c), "requests from this client");
    const circle = await supportOr404(c.req.param("id"));
    const mandateId = readUnits(c.req.param("mandateId"), "mandateId", { min: 1n, max: MAX_UINT256 });
    const body = validateSupporterName(await readJson(c), nowSeconds());
    // A name usually arrives moments after the install, often before the indexer has seen the
    // mandate. Then it is kept against its signer and shown once the mandate is indexed with that
    // signer as its payer or manager; once indexed, a mismatch is refused outright.
    const [mandate] = await store.mandates({ mandateId }, nowSeconds(), 1);
    if (mandate !== undefined) {
      if (mandate.support?.id !== circle.id) throw notFound(`Mandate ${mandateId} does not support this circle`);
      if (!isAddressEqual(body.signer, mandate.payer) && !isAddressEqual(body.signer, mandate.manager)) {
        throw badRequest("Only the supporter, or the key that manages their payment, can name them");
      }
    }
    const signed = await signedBy({
      address: body.signer,
      ...supporterNameTypedData({ chainId: network.chainId, hub: deployment.hub, mandateId, name: body.name, deadline: BigInt(body.deadline) }),
      signature: body.signature,
    });
    if (!signed) throw badRequest("The signature is not the signer's");
    await store.setSupporterName(mandateId, body.signer, body.name, nowSeconds());
    return c.json({ name: body.name }, mandate === undefined ? 202 : 200);
  });

  /*//////////////////////////////////////////////////////////////
                            PUSH REMINDERS
  //////////////////////////////////////////////////////////////*/

  app.get(API_ROUTES.pushKey, (c) => {
    if (deps.pushPublicKey === undefined) throw notFound("Reminders are not switched on on this server");
    const response: PushKeyResponse = { publicKey: deps.pushPublicKey };
    return c.json(response);
  });

  app.post(API_ROUTES.pushSubscriptions, async (c) => {
    limit(limits.relayPerIp, clientIp(c), "requests from this client");
    if (deps.pushPublicKey === undefined) throw notFound("Reminders are not switched on on this server");
    const request = validatePushSubscription(await readJson(c), nowSeconds());
    // The payer, or a session key that manages one of their payments: either way someone who can
    // already stop them, so a stranger can never have a payer's reminders sent to themselves.
    const allowed = isAddressEqual(request.signer, request.payer) || (await store.managesAny(request.payer, request.signer));
    if (!allowed) throw badRequest("Only the payer, or the key that manages their payments, can ask for their reminders");
    const signed = await signedBy({
      address: request.signer,
      ...pushSubscriptionTypedData({
        chainId: network.chainId,
        payer: request.payer,
        endpoint: request.subscription.endpoint,
        deadline: BigInt(request.deadline),
      }),
      signature: request.signature,
    });
    if (!signed) throw badRequest("The signature is not the signer's");
    await store.savePushSubscription(request.payer, request.subscription, nowSeconds());
    return c.json({ subscribed: true }, 201);
  });

  app.delete(API_ROUTES.pushSubscriptions, async (c) => {
    const body = readObject(await readJson(c), "body", ["endpoint"]);
    await store.deletePushSubscription(field(body, "endpoint", readPushEndpoint));
    return c.body(null, 204);
  });

  app.post(API_ROUTES.savings, async (c) => {
    limit(limits.relayPerIp, clientIp(c), "relay requests from this client");
    const input = parseSavings(await readJson(c), nowSeconds());
    const relay = requireRelay();
    try {
      // Counted once the owner's permit has simulated, as installs are, so nobody can use up an
      // owner's allowance of moves with signatures that were never theirs.
      return c.json(await relay.savings(input, () => limit(limits.savingsPerOwner, input.owner, "savings moves for this account")));
    } catch (error) {
      relayError(error);
    }
  });

  app.post(API_ROUTES.faucet, async (c) => {
    const token = deployment.testStablecoin;
    if (network.mainnet || token === undefined) throw notFound("There is no faucet on this network");
    const body = readObject(await readJson(c), "body", ["address"]);
    const address = field(body, "address", readAddress);
    const relay = requireRelay();

    limit(limits.faucetPerIp, clientIp(c), "faucet requests from this client");
    if (faucetInFlight.has(address)) throw rateLimited("A faucet request for this address is already in flight", 5);
    const last = await store.lastFaucetGrant(address);
    const elapsed = last === undefined ? Infinity : nowSeconds() - last;
    if (elapsed < FAUCET_ADDRESS_COOLDOWN_SECONDS) {
      throw rateLimited("This address was funded recently", FAUCET_ADDRESS_COOLDOWN_SECONDS - elapsed);
    }

    faucetInFlight.add(address);
    try {
      const granted = await relay.faucet(address, token, deps.faucetAmount);
      await store.recordFaucetGrant(address, deps.faucetAmount, granted.transaction, nowSeconds());
      return c.json(granted);
    } catch (error) {
      relayError(error);
    } finally {
      faucetInFlight.delete(address);
    }
  });

  /*//////////////////////////////////////////////////////////////
                               MERCHANT
  //////////////////////////////////////////////////////////////*/

  /**
   * Who is signed in, and their merchant, created on first sight. A new merchant's payout address
   * starts as the first wallet it has proven it controls: the embedded Privy wallet, or the dev
   * address. When that lookup fails the merchant starts without one and picks it in the dashboard.
   */
  const session = async (c: Context): Promise<{ identity: MerchantIdentity; merchant: MerchantRow }> => {
    const identity = await deps.auth(c.req.header("authorization"));
    const existing = await store.findMerchant(identity.subject);
    if (existing !== undefined) return { identity, merchant: existing };
    let payout: Address | undefined;
    try {
      payout = (await identity.wallets())[0];
    } catch (error) {
      deps.logger.warn("could not read a new merchant's wallets", { error: messageOf(error) });
    }
    return { identity, merchant: await store.ensureMerchant(identity.subject, nowSeconds(), payout) };
  };
  const signIn = async (c: Context): Promise<MerchantRow> => (await session(c)).merchant;

  /** Refuses a payout address the signed-in merchant has not proven it controls. */
  const requireOwnedPayout = async (identity: MerchantIdentity, payout: Address): Promise<void> => {
    const owns = (wallets: readonly Address[]) => wallets.some((wallet) => isAddressEqual(wallet, payout));
    let wallets: readonly Address[];
    try {
      // A wallet linked a moment ago may not be in the cached answer yet: ask once more before refusing.
      wallets = await identity.wallets();
      if (!owns(wallets)) wallets = await identity.wallets({ fresh: true });
    } catch (error) {
      deps.logger.warn("could not read a merchant's wallets", { error: messageOf(error) });
      throw notConfigured("Could not check which wallets are linked to your account; try again shortly");
    }
    if (!owns(wallets)) {
      throw badRequest("payoutAddress must be a wallet linked to your account; link it when you sign in, then choose it");
    }
  };

  app.get(API_ROUTES.merchant, async (c) => c.json(toMerchantProfile(await signIn(c))));

  app.get(API_ROUTES.payout, async (c) => {
    await signIn(c);
    const info: PayoutInfo = { spender: requireRelay().address };
    return c.json(info);
  });

  const requireAnalytics = (): EnvioAnalytics => {
    if (deps.analytics === undefined) throw notConfigured("Analytics are not configured on this server");
    return deps.analytics;
  };

  /** Revenue, MRR, customers and what charged them, across every wallet the business is paid to. */
  app.get(API_ROUTES.merchantAnalytics, async (c) => {
    const merchant = await signIn(c);
    const analytics = requireAnalytics();
    const wallets = await store.merchantWallets(merchant.id);
    const response: MerchantAnalytics = await analytics.merchant(network.chainId, wallets, nowSeconds());
    return c.json(response);
  });

  /** A business sends its earnings on from its own wallet; the relayer pays the fee. */
  app.post(API_ROUTES.payout, async (c) => {
    const { identity, merchant } = await session(c);
    const input = parsePayout(await readJson(c), nowSeconds());
    if (!Object.values(deployment.assets).some((asset) => isAddressEqual(asset, input.asset))) {
      throw badRequest("asset is not one Weir pays out");
    }
    await requireOwnedPayout(identity, input.owner);
    const relay = requireRelay();
    try {
      const response: PayoutResponse = await relay.payout(input, () => limit(limits.payoutsPerMerchant, merchant.id, "payouts for this business"));
      return c.json(response);
    } catch (error) {
      relayError(error);
    }
  });

  app.put(API_ROUTES.merchant, async (c) => {
    const { identity, merchant } = await session(c);
    const merchantId = merchant.id;
    const body = readObject(await readJson(c), "body", ["name", "payoutAddress", "webhookUrl"]);
    const name = optionalField(body, "name", (v, p) => readText(v, p, { min: 1, max: 80 }));
    const payoutAddress = optionalField(body, "payoutAddress", readAddress);
    if (payoutAddress !== undefined && (isAddressEqual(payoutAddress, zeroAddress) || isAddressEqual(payoutAddress, deployment.hub))) {
      throw badRequest("payoutAddress cannot be the zero address or the hub");
    }
    if (payoutAddress !== undefined) await requireOwnedPayout(identity, payoutAddress);
    const webhookUrl = optionalField(body, "webhookUrl", (v, p) => {
      if (v === null) return null;
      if (typeof v !== "string") throw badRequest(`${p} must be a URL or null`);
      return validateWebhookUrl(v.trim(), deps.webhookPolicy);
    });

    const updated = await store.updateMerchant(
      merchantId,
      {
        ...(name === undefined ? {} : { name }),
        ...(payoutAddress === undefined ? {} : { payoutAddress }),
        ...(webhookUrl === undefined ? {} : { webhookUrl }),
      },
      nowSeconds(),
    );
    const response: UpdateMerchantResponse = {
      ...toMerchantProfile(updated.row),
      ...(updated.webhookSecret === undefined ? {} : { webhookSecret: updated.webhookSecret }),
    };
    return c.json(response);
  });

  app.get(API_ROUTES.merchantOverview, async (c) => {
    const row = await signIn(c);
    const at = nowSeconds();
    const mandates = await store.mandates({ merchantId: row.id }, at, 100_000);
    const overview: MerchantOverview = {
      profile: toMerchantProfile(row),
      plans: await store.listPlans(row.id),
      mandates: mandates.slice(0, 500),
      charges: await store.charges({ merchantId: row.id }, 100),
      stats: merchantStats(mandates, await store.collectedSince(row.id, at - THIRTY_DAYS)),
    };
    return c.json(overview);
  });

  app.get(API_ROUTES.plans, async (c) => {
    const { id: merchantId } = await signIn(c);
    const response: PlanListResponse = { plans: await store.listPlans(merchantId) };
    return c.json(response);
  });

  app.post(API_ROUTES.plans, async (c) => {
    const merchant = await signIn(c);
    const plan = validatePlan(await readJson(c), symbolFor);
    if (merchant.payout_address === null) throw badRequest("Set a payout address with PUT /v1/merchant before creating a plan");
    const created = await store.insertPlan(merchant.id, newPlanId(), plan, nowSeconds());
    return c.json(created, 201);
  });

  app.get("/v1/merchant/plans/:id", async (c) => {
    const { id: merchantId } = await signIn(c);
    const plan = await store.getMerchantPlan(merchantId, c.req.param("id"));
    if (plan === undefined) throw notFound(`No plan ${c.req.param("id")}`);
    return c.json(plan);
  });

  app.patch("/v1/merchant/plans/:id", async (c) => {
    const { id: merchantId } = await signIn(c);
    const body = readObject(await readJson(c), "body", ["active"]);
    const active = field(body, "active", readBoolean);
    const plan = await store.setPlanActive(merchantId, c.req.param("id"), active);
    if (plan === undefined) throw notFound(`No plan ${c.req.param("id")}`);
    return c.json(plan);
  });

  return app;
}
