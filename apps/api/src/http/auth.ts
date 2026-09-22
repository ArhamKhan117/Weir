/**
 * Who a merchant request is from.
 *
 * `Authorization: Bearer <Privy access token>` is verified with `@privy-io/server-auth`, and the
 * merchant is keyed by the Privy user id. With `WEIR_DEV_AUTH=1`, which the config refuses on
 * Mainnet, `Authorization: Dev <address>` is also accepted and names a merchant keyed by that
 * address. Without Privy credentials the merchant routes answer 503 `not_configured`, except for
 * the dev scheme when it is on.
 *
 * An identity also says which wallets its merchant has proven it controls, since a payout address
 * must be one of them: money a merchant cannot move is money lost. For Privy they are the EVM
 * wallets linked to the user, embedded wallet first, read from Privy on demand and cached briefly.
 * For the dev scheme it is the address signed in as.
 *
 * The Privy client is loaded on first use, so a process that never verifies a token never loads
 * the SDK.
 */

import { linkedEvmWallets, type LinkedAccountLike } from "@weir/shared";
import type { Address } from "viem";

import { messageOf, type Logger } from "../log.js";
import { notConfigured, unauthorized } from "./errors.js";
import { readAddress } from "./validate.js";

export interface MerchantIdentity {
  /** Stable key for the merchant: the Privy user id, or `dev:<address>`. */
  subject: string;
  /**
   * The wallets this merchant has proven it controls, the one a new merchant's payout defaults to
   * first. `fresh` skips the cache, for a wallet linked a moment ago.
   */
  wallets(options?: { fresh?: boolean }): Promise<readonly Address[]>;
}

/** Verifies a Privy access token and returns its user id. Throws when it does not verify. */
export type TokenVerifier = (token: string) => Promise<string>;

/** The EVM wallets linked to a Privy user, embedded wallet first. */
export type WalletLister = (userId: string) => Promise<readonly Address[]>;

export interface MerchantAuthOptions {
  privy?: { appId: string; appSecret: { reveal(): string } };
  devAuth: boolean;
  logger: Logger;
  /** Injected in tests; built from `privy` otherwise. */
  verifier?: TokenVerifier;
  /** Injected in tests; built from `privy` otherwise. */
  wallets?: WalletLister;
}

export type MerchantAuth = (authorization: string | undefined) => Promise<MerchantIdentity>;

/** How long a user's linked wallets are reused. Privy rate-limits the lookup by user id. */
const WALLETS_TTL_MS = 60_000;

interface PrivyApi {
  verifyAuthToken(token: string): Promise<{ userId: string; appId: string }>;
  getUserById(userId: string): Promise<{ linkedAccounts: readonly LinkedAccountLike[] }>;
}

function privyApi(appId: string, appSecret: { reveal(): string }): { verifier: TokenVerifier; wallets: WalletLister } {
  let client: Promise<PrivyApi> | undefined;
  const privy = () =>
    (client ??= import("@privy-io/server-auth").then(({ PrivyClient }) => new PrivyClient(appId, appSecret.reveal()) as PrivyApi));
  return {
    async verifier(token) {
      const claims = await (await privy()).verifyAuthToken(token);
      if (claims.appId !== appId) throw new Error("the token was issued for another app");
      return claims.userId;
    },
    async wallets(userId) {
      return linkedEvmWallets((await (await privy()).getUserById(userId)).linkedAccounts);
    },
  };
}

/** `lister` behind a short per-user cache that a failed lookup never fills. */
function cachedWallets(lister: WalletLister): (userId: string, fresh: boolean) => Promise<readonly Address[]> {
  const cache = new Map<string, { at: number; value: Promise<readonly Address[]> }>();
  return (userId, fresh) => {
    const hit = cache.get(userId);
    if (!fresh && hit !== undefined && Date.now() - hit.at < WALLETS_TTL_MS) return hit.value;
    const value = lister(userId);
    cache.set(userId, { at: Date.now(), value });
    value.catch(() => {
      if (cache.get(userId)?.value === value) cache.delete(userId);
    });
    if (cache.size > 10_000) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) cache.delete(oldest.value);
    }
    return value;
  };
}

export function createMerchantAuth(options: MerchantAuthOptions): MerchantAuth {
  const privy = options.privy === undefined ? undefined : privyApi(options.privy.appId, options.privy.appSecret);
  const verifier = options.verifier ?? privy?.verifier;
  const lister = options.wallets ?? privy?.wallets;
  const walletsOf = lister === undefined ? undefined : cachedWallets(lister);

  return async (authorization) => {
    if (verifier === undefined && !options.devAuth) {
      throw notConfigured("Merchant sign-in is not configured on this server");
    }
    if (authorization === undefined || authorization.trim() === "") {
      throw unauthorized("Sign in: send Authorization: Bearer <access token>");
    }
    const [scheme = "", ...rest] = authorization.trim().split(/\s+/);
    const credential = rest.join(" ");

    if (scheme.toLowerCase() === "dev") {
      if (!options.devAuth) throw unauthorized("Dev auth is off on this server");
      let address: Address;
      try {
        address = readAddress(credential, "the Dev credential");
      } catch {
        throw unauthorized("The Dev credential must be a 20-byte 0x address");
      }
      return { subject: `dev:${address}`, wallets: async () => [address] };
    }
    if (scheme.toLowerCase() === "bearer") {
      if (verifier === undefined) throw notConfigured("Privy sign-in is not configured on this server");
      if (credential === "") throw unauthorized("The bearer token is empty");
      let userId: string;
      try {
        userId = await verifier(credential);
      } catch (error) {
        options.logger.warn("merchant token refused", { error: messageOf(error) });
        throw unauthorized("The access token did not verify; sign in again");
      }
      return {
        subject: userId,
        wallets: async ({ fresh = false } = {}) => (walletsOf === undefined ? [] : walletsOf(userId, fresh)),
      };
    }
    throw unauthorized("Unsupported Authorization scheme; use Bearer");
  };
}
