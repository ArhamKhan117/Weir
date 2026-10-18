/**
 * A paid API, to show `weir-meter` working end to end: `GET /demo/fx?to=PKR` answers today's
 * dollar rate for a currency, for a tenth of a cent a request.
 *
 * It is built exactly as any business would build one: `@weir/x402`'s paywall in front of a
 * handler, paying out to an address of its own, verified and recorded by Weir's facilitator. The
 * only shortcut is transport: the paywall reaches the facilitator in-process rather than over the
 * network, through the same HTTP routes.
 */

import { createPaywall, type SuggestedTerms } from "@weir/x402";
import { Hono } from "hono";
import { isAddressEqual, type Address } from "viem";

import { limitReached } from "../http/errors.js";

const RATES_URL = "https://open.er-api.com/v6/latest/USD";
const RATES_TTL_MS = 10 * 60_000;

export interface DemoOptions {
  chainId: number;
  meter: Address;
  name: string;
  version: string;
  /** The facilitator's public base URL, which payers are told. */
  facilitator: string;
  payTo: Address;
  asset: Address;
  /** Per request, base units. */
  price: bigint;
  suggested: SuggestedTerms;
  /** How the paywall reaches the facilitator. */
  fetch: typeof fetch;
  /** Today's rates against the dollar; open.er-api.com by default. */
  rates?: () => Promise<Record<string, number>>;
}

export interface DemoGateOptions {
  payTo: Address;
  /** At most this many people may open a meter paying the demo. */
  maxPayers?: number;
  /** No new meter while the relayer holds less than this, in wei. */
  gasReserve?: bigint;
  /** How many people already pay the demo, and whether this payer is one of them. */
  payers: (payer: Address) => Promise<{ people: number; known: boolean }>;
  relayerBalance: () => Promise<bigint>;
  /** Where else to try it, appended to a refusal. */
  elsewhere?: string;
}

/**
 * Whether a meter may be opened, checked before the relayer sends anything. Only meters paying the
 * demo are limited: each costs the relayer gas to open, settle and stop, so on Mainnet the demo
 * takes a fixed number of people, and pauses before it could spend gas real payments need. A
 * person already counted may approve again.
 */
export function createDemoGate(options: DemoGateOptions): (meter: { payer: Address; merchant: Address }) => Promise<void> {
  const after = options.elsewhere === undefined ? "" : ` ${options.elsewhere}`;
  return async ({ payer, merchant }) => {
    if (!isAddressEqual(merchant, options.payTo)) return;
    if (options.maxPayers !== undefined) {
      const { people, known } = await options.payers(payer);
      if (!known && people >= options.maxPayers) throw limitReached(`The demo was for the first ${options.maxPayers} ${options.maxPayers === 1 ? "person" : "people"}, and they have tried it.${after}`);
    }
    if (options.gasReserve !== undefined && (await options.relayerBalance()) < options.gasReserve) {
      throw limitReached(`The demo is paused for now.${after}`);
    }
  };
}

export function createDemo(options: DemoOptions): Hono {
  let rates: { at: number; value: Promise<Record<string, number>> } | undefined;
  const fetchRates = (): Promise<Record<string, number>> => {
    if (rates !== undefined && Date.now() - rates.at < RATES_TTL_MS) return rates.value;
    const value = fetch(RATES_URL, { signal: AbortSignal.timeout(10_000) })
      .then((response) => response.json() as Promise<{ result?: string; rates?: Record<string, number> }>)
      .then((body) => {
        if (body.result !== "success" || body.rates === undefined) throw new Error("the rates source did not answer");
        return body.rates;
      });
    value.catch(() => (rates = undefined));
    rates = { at: Date.now(), value };
    return value;
  };

  const loadRates = options.rates ?? fetchRates;

  const paywall = createPaywall({
    chainId: options.chainId,
    meter: options.meter,
    name: options.name,
    version: options.version,
    facilitator: options.facilitator,
    payTo: options.payTo,
    asset: options.asset,
    price: options.price,
    suggested: options.suggested,
    description: "Today's dollar exchange rate for one currency",
    mimeType: "application/json",
    // The host ends TLS, so the request arrives as http; payers are told the public address.
    resourceUrl: (request) => {
      const url = new URL(request.url);
      return new URL(`${url.pathname}${url.search}`, options.facilitator).toString();
    },
    fetch: options.fetch,
  });

  const app = new Hono();
  app.get("/fx", (c) =>
    paywall(c.req.raw, async () => {
      const to = (c.req.query("to") ?? "").toUpperCase();
      if (!/^[A-Z]{3}$/.test(to)) return Response.json({ error: "to must be a three-letter currency code" }, { status: 400 });
      let table: Record<string, number>;
      try {
        table = await loadRates();
      } catch {
        return Response.json({ error: "The rates source is unavailable" }, { status: 503 });
      }
      const rate = table[to];
      if (rate === undefined) return Response.json({ error: `No rate for ${to}` }, { status: 404 });
      return Response.json({ base: "USD", to, rate, source: "open.er-api.com", at: Math.floor(Date.now() / 1000) });
    }),
  );
  return app;
}
