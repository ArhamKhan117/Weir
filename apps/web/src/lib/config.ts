/**
 * Configuration: build-time `VITE_*` variables Vite inlines, with defaults that work against the
 * local APIs behind the dev server's proxy, and the network the visitor chose.
 *
 * Weir runs on Monad Mainnet and Testnet, and a visitor switches between them. The choice is made
 * once, at load: `?network=mainnet` or `?network=testnet` in the address, else the last choice
 * saved in this browser, else the build's `VITE_CHAIN_ID` (Mainnet by default). Switching saves the new choice and
 * reloads, so everything below stays a constant for the life of the page.
 */

import { deploymentFor, isMonadChainId, MONAD_MAINNET_CHAIN_ID, MONAD_TESTNET_CHAIN_ID, networkFor, requireDeployment, type MonadChainId } from "@weir/shared";

// Mainnet unless the build says otherwise.
const buildChainId = Number(import.meta.env.VITE_CHAIN_ID ?? "143");
if (!isMonadChainId(buildChainId)) throw new Error(`VITE_CHAIN_ID ${buildChainId} is not a Monad network`);

const NETWORK_KEY = "weir.network";
const SLUGS: Readonly<Record<MonadChainId, string>> = { [MONAD_MAINNET_CHAIN_ID]: "mainnet", [MONAD_TESTNET_CHAIN_ID]: "testnet" };

/**
 * The API that serves `chainId`, or `undefined` when this build has none for it. Each network has
 * its own API: `VITE_API_URL_MAINNET` and `VITE_API_URL_TESTNET`, with `VITE_API_URL` (or this
 * origin) for the build's own network. In development the dev server proxies `/mainnet` and
 * `/testnet` to the two local APIs.
 */
function apiUrlFor(chainId: MonadChainId): string | undefined {
  const explicit = chainId === MONAD_MAINNET_CHAIN_ID ? import.meta.env.VITE_API_URL_MAINNET : import.meta.env.VITE_API_URL_TESTNET;
  if (explicit !== undefined && explicit !== "") return explicit;
  if (import.meta.env.DEV) return `/${SLUGS[chainId]}`;
  return chainId === buildChainId ? (import.meta.env.VITE_API_URL ?? "") : undefined;
}

/** The networks a visitor can choose: deployed, and served by an API this build knows. */
export const NETWORK_CHOICES: readonly MonadChainId[] = [MONAD_MAINNET_CHAIN_ID, MONAD_TESTNET_CHAIN_ID].filter(
  (id) => deploymentFor(id) !== undefined && apiUrlFor(id) !== undefined,
);

function chosenChainId(): MonadChainId {
  const allowed = (id: number): id is MonadChainId => isMonadChainId(id) && NETWORK_CHOICES.includes(id);
  try {
    const slug = new URLSearchParams(window.location.search).get("network");
    const fromUrl = slug === SLUGS[MONAD_MAINNET_CHAIN_ID] ? MONAD_MAINNET_CHAIN_ID : slug === SLUGS[MONAD_TESTNET_CHAIN_ID] ? MONAD_TESTNET_CHAIN_ID : 0;
    if (allowed(fromUrl)) {
      window.localStorage.setItem(NETWORK_KEY, String(fromUrl));
      return fromUrl;
    }
    const saved = Number(window.localStorage.getItem(NETWORK_KEY));
    if (allowed(saved)) return saved;
  } catch {
    // Storage refused (a private window): the build's network.
  }
  return buildChainId as MonadChainId;
}

export const CHAIN_ID: MonadChainId = chosenChainId();
export const NETWORK = networkFor(CHAIN_ID);
export const DEPLOYMENT = requireDeployment(CHAIN_ID);
export const IS_TESTNET = CHAIN_ID === MONAD_TESTNET_CHAIN_ID;

/** The chosen network's API; empty means this origin, which the dev server proxies. */
export const API_URL: string = apiUrlFor(CHAIN_ID) ?? "";

/** Switches to `chainId`: saves the choice, puts it in the address too, and reloads. */
export function switchNetwork(chainId: MonadChainId): void {
  if (chainId === CHAIN_ID) return;
  try {
    window.localStorage.setItem(NETWORK_KEY, String(chainId));
  } catch {
    // Without storage the address alone carries the choice.
  }
  const url = new URL(window.location.href);
  url.searchParams.set("network", SLUGS[chainId]);
  // A checkout or a support page belongs to one network's API; the other network starts at home.
  if (!["/", "/payments", "/support", "/dashboard"].includes(url.pathname)) url.pathname = "/";
  window.location.assign(url.toString());
}

/**
 * A plan whose checkout the landing page links to, for trying the product in one click. Plans live
 * in each network's API, so Mainnet has its own.
 */
export const DEMO_PLAN_ID: string | undefined =
  (IS_TESTNET ? import.meta.env.VITE_DEMO_PLAN_ID : import.meta.env.VITE_DEMO_PLAN_ID_MAINNET) || undefined;

/** The marketing site, which the footer links back to; absent, the link is left out. */
export const SITE_URL: string | undefined = import.meta.env.VITE_SITE_URL || undefined;

/** Privy, for merchant sign-in. Without it the dashboard offers development sign-in, in dev builds only. */
export const PRIVY_APP_ID: string | undefined = import.meta.env.VITE_PRIVY_APP_ID || undefined;

/**
 * Aurora's Intents widget, for adding money from any chain. Its key is public by design: it names
 * the integration for Aurora's fee accounting and ships in every page that shows the widget.
 */
export const AURORA_API_KEY: string | undefined = import.meta.env.VITE_AURORA_API_KEY || undefined;

/**
 * What a top-up through NEAR Intents can deliver on Monad Mainnet, keyed by token address: Intents
 * lists USDC on Monad, not AUSD.
 */
export const TOP_UP_ASSETS: Readonly<Record<string, { symbol: string; intentsAssetId: string }>> = {
  "0x754704bc059f8c67012fed69bc8a327a5aafb603": {
    symbol: "USDC",
    intentsAssetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
  },
};

/**
 * Whether "Add money" is offered. Intents moves real dollars on Monad Mainnet only, so a Testnet
 * build offers the faucet instead; a development build shows it as a preview so it can be tried.
 */
export const TOP_UP_AVAILABLE = AURORA_API_KEY !== undefined && (!IS_TESTNET || import.meta.env.DEV);

/** Whether a top-up can deliver `asset`, for real: on Mainnet, and an asset Intents lists. */
export function canTopUp(asset: string): boolean {
  return TOP_UP_AVAILABLE && !IS_TESTNET && TOP_UP_ASSETS[asset.toLowerCase()] !== undefined;
}

/** WalletConnect Cloud, for linking a mobile wallet to a business account through Privy. */
export const WALLETCONNECT_PROJECT_ID: string | undefined = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || undefined;

/**
 * Development sign-in for the dashboard: in dev builds without Privy, or when `?devauth=1` asks for
 * it, until `?devauth=0`. Testnet only: the API accepts it only with development auth switched
 * on, which it refuses on Mainnet, so Mainnet always signs in with Privy. Never in a production build.
 */
export const DEV_MERCHANT_AUTH = import.meta.env.DEV && IS_TESTNET && (PRIVY_APP_ID === undefined || devAuthRequested());

function devAuthRequested(): boolean {
  const FLAG = "weir.dev-auth";
  try {
    const param = new URLSearchParams(window.location.search).get("devauth");
    if (param === "1") window.localStorage.setItem(FLAG, "1");
    if (param === "0") window.localStorage.removeItem(FLAG);
    return window.localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}
