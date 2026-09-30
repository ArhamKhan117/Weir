/**
 * What a dollar amount is worth in someone's local currency, for showing beside it ("≈ ₨13,900").
 *
 * Where Chainlink publishes the currency on Monad (EUR, GBP, CAD, CHF, JPY), the rate is read from
 * its feed on Monad Mainnet, whichever network the app is on: the rate is the same, and Testnet has
 * no fiat feeds. Every other currency comes from a public market rate. A rate is only ever shown,
 * never used to move money, and the page says which source it came from.
 */

import { CHAINLINK_FIAT_FEEDS, localCurrency, monadMainnet, UNIT } from "@weir/shared";
import { useEffect, useState } from "react";
import { createPublicClient, fallback, http, parseAbi } from "viem";

export interface Rate {
  /** Units of the currency one US dollar buys. */
  readonly perDollar: number;
  readonly source: "chainlink" | "market";
}

const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);
/** A Chainlink answer older than this is not shown; the market rate stands in. */
const STALE_SECONDS = 86_400;
const MARKET_URL = "https://open.er-api.com/v6/latest/USD";
const MARKET_KEY = "weir.fx.market";
const MARKET_TTL_MS = 6 * 3_600_000;

let mainnet: ReturnType<typeof createPublicClient> | undefined;
function mainnetClient() {
  mainnet ??= createPublicClient({
    chain: monadMainnet,
    transport: fallback(monadMainnet.rpcUrls.default.http.map((url) => http(url, { retryCount: 2, timeout: 10_000 }))),
  });
  return mainnet;
}

async function chainlinkRate(code: string): Promise<Rate | undefined> {
  const feed = CHAINLINK_FIAT_FEEDS[code];
  if (feed === undefined) return undefined;
  const client = mainnetClient();
  const [[, answer, , updatedAt], decimals] = await Promise.all([
    client.readContract({ address: feed, abi: FEED_ABI, functionName: "latestRoundData" }),
    client.readContract({ address: feed, abi: FEED_ABI, functionName: "decimals" }),
  ]);
  if (answer <= 0n || Date.now() / 1000 - Number(updatedAt) > STALE_SECONDS) return undefined;
  // The feed quotes one unit of the currency in dollars; a dollar buys the inverse.
  return { perDollar: 10 ** decimals / Number(answer), source: "chainlink" };
}

let market: Promise<Record<string, number>> | undefined;
function marketRates(): Promise<Record<string, number>> {
  market ??= (async () => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(MARKET_KEY) ?? "null") as { at: number; rates: Record<string, number> } | null;
      if (saved !== null && Date.now() - saved.at < MARKET_TTL_MS) return saved.rates;
    } catch {
      // No storage: fetch.
    }
    const response = await fetch(MARKET_URL);
    if (!response.ok) throw new Error(`rates answered ${response.status}`);
    const body = (await response.json()) as { result?: string; rates?: Record<string, number> };
    if (body.result !== "success" || body.rates === undefined) throw new Error("rates unavailable");
    try {
      window.localStorage.setItem(MARKET_KEY, JSON.stringify({ at: Date.now(), rates: body.rates }));
    } catch {
      // Not cached; fetched again next load.
    }
    return body.rates;
  })().catch((error: unknown) => {
    market = undefined;
    throw error;
  });
  return market;
}

const rates = new Map<string, Promise<Rate | undefined>>();

/** The rate for `code`, from Chainlink on Monad when it publishes one, else the market. */
export function rateFor(code: string): Promise<Rate | undefined> {
  if (localCurrency(code) === undefined) return Promise.resolve(undefined);
  let rate = rates.get(code);
  if (rate === undefined) {
    rate = chainlinkRate(code)
      .catch(() => undefined)
      .then(async (onchain) => {
        if (onchain !== undefined) return onchain;
        const perDollar = (await marketRates())[code];
        return perDollar === undefined ? undefined : { perDollar, source: "market" as const };
      })
      .catch(() => undefined);
    rates.set(code, rate);
    // A failure is not remembered: the next page to ask tries again.
    void rate.then((r) => r === undefined && rates.delete(code));
  }
  return rate;
}

/** `units` of dollars in `code`, rounded as people quote that currency: "₨2,775", "€8.92". */
export function formatLocal(units: bigint, code: string, rate: Rate): string {
  const value = (Number(units) / Number(UNIT)) * rate.perDollar;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code,
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: value >= 100 ? 0 : 2,
    minimumFractionDigits: 0,
  }).format(value);
}

export function rateSource(rate: Rate): string {
  return rate.source === "chainlink" ? "Rate from Chainlink on Monad" : "Market rate, updated daily";
}

/** The rate for `code` once it has loaded; `undefined` while loading, for no currency, or if none is available. */
export function useRate(code: string | undefined): Rate | undefined {
  const [rate, setRate] = useState<Rate | undefined>();
  useEffect(() => {
    setRate(undefined);
    if (code === undefined || code === "") return;
    let live = true;
    void rateFor(code).then((r) => live && setRate(r));
    return () => {
      live = false;
    };
  }, [code]);
  return rate;
}
