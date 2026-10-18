/**
 * The paying fetch: a drop-in `fetch` that answers `weir-meter` offers by itself.
 *
 * A request goes out as usual. On a `402` offering `weir-meter` at or under `maxPrice`, it finds
 * the meter that pays that API (one this key may sign for), signs the next running total (the
 * last accepted total plus this request's price), and sends the request again with the payment.
 * No prompt and no transaction: the signer is a key already held, typically a session key.
 *
 * Receipts on one meter are signed one at a time, because each builds on the last; requests on
 * different meters run in parallel. If the facilitator's total moved (another device on the same
 * meter), the total is read again and the request retried once.
 *
 * Once an endpoint has been paid, the next request to it carries its payment from the start, so a
 * paid request costs one round trip, not two. Should the endpoint's offer have changed since, its
 * 402 is read afresh and the request paid on the new terms.
 */

import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { usageReceiptTypedData, type MeterDetail, type MeterListResponse } from "@weir/shared";
import type { Address, Hex, LocalAccount } from "viem";

import { getFacilitator } from "./facilitator.js";
import {
  METER_REASONS,
  meterPaymentPayload,
  readMeterRequirement,
  sameOffer,
  WEIR_METER_SCHEME,
  X402_HEADERS,
  type MeterOffer,
} from "./scheme.js";

export type MeterSigner = Pick<LocalAccount, "address" | "signTypedData">;

export interface MeterPaymentEvent {
  offer: MeterOffer;
  meterId: bigint;
  /** The running total signed for this request. */
  total: bigint;
  url: string;
  settlement?: SettleResponse;
}

export interface MeterFetchOptions {
  signer: MeterSigner;
  /** The most one request may cost, in base units. A request priced above it is refused. */
  maxPrice: bigint;
  /** The meter that pays an offer. By default, the first open one the facilitator lists for this signer and payee. */
  meterFor?: (offer: MeterOffer) => Promise<bigint | undefined>;
  fetch?: typeof fetch;
  /** Unix seconds. */
  now?: () => number;
  onPayment?: (event: MeterPaymentEvent) => void;
}

/** A `402` offering `weir-meter` from an API this signer has no meter with yet. */
export class NoMeterError extends Error {
  constructor(readonly offer: MeterOffer) {
    super(`No open Weir meter pays ${offer.payTo} on chain ${offer.chainId}; approve this API first`);
    this.name = "NoMeterError";
  }
}

export class PriceTooHighError extends Error {
  constructor(
    readonly offer: MeterOffer,
    readonly maxPrice: bigint,
  ) {
    super(`The request costs ${offer.price} base units, above the ${maxPrice} allowed`);
    this.name = "PriceTooHighError";
  }
}

/** The `PaymentRequired` in a 402, from its header or else its body. */
async function paymentRequiredOf(response: Response): Promise<PaymentRequired | undefined> {
  const header = response.headers.get(X402_HEADERS.paymentRequired);
  try {
    if (header !== null) return decodePaymentRequiredHeader(header);
    return (await response.clone().json()) as PaymentRequired;
  } catch {
    return undefined;
  }
}

/** Every `weir-meter` offer in a 402, read strictly; malformed ones are skipped. */
export function meterOffersOf(required: PaymentRequired): { requirement: PaymentRequirements; offer: MeterOffer }[] {
  const out: { requirement: PaymentRequirements; offer: MeterOffer }[] = [];
  for (const requirement of required.accepts ?? []) {
    if (requirement.scheme !== WEIR_METER_SCHEME) continue;
    try {
      out.push({ requirement, offer: readMeterRequirement(requirement) });
    } catch {
      // Not one this client can pay.
    }
  }
  return out;
}

export function createMeterFetch(options: MeterFetchOptions): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  /** The last total this client knows was accepted, per meter. */
  const accepted = new Map<string, bigint>();
  /** One receipt at a time per meter. */
  const queues = new Map<string, Promise<unknown>>();

  const serial = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    queues.set(key, next.catch(() => undefined));
    return next;
  };

  const defaultMeterFor = async (offer: MeterOffer): Promise<bigint | undefined> => {
    const query = new URLSearchParams({ signer: options.signer.address, payTo: offer.payTo, asset: offer.asset });
    const list = await getFacilitator<MeterListResponse>(fetchImpl, `${offer.facilitator}/v1/x402/meters?${query}`);
    const open = list.meters.find((meter) => meter.status !== "Cancelled" && meter.meter === offer.meter);
    return open === undefined ? undefined : BigInt(open.id);
  };

  const acceptedTotal = async (offer: MeterOffer, meterId: bigint, key: string, fresh: boolean): Promise<bigint> => {
    const known = accepted.get(key);
    if (known !== undefined && !fresh) return known;
    const detail = await getFacilitator<MeterDetail>(fetchImpl, `${offer.facilitator}/v1/x402/meters/${meterId}`);
    const total = BigInt(detail.accepted);
    accepted.set(key, total);
    return total;
  };

  interface Plan {
    required: PaymentRequired;
    requirement: PaymentRequirements;
    offer: MeterOffer;
    meterId: bigint;
  }

  /**
   * What each endpoint asked last time, so the next request to it is paid up front: one round trip
   * instead of two. Keyed by method and URL, since a price may depend on either.
   */
  const remembered = new Map<string, Plan>();

  /** Reads a 402 into what to pay: `undefined` when it offers nothing this client can pay. */
  const planFor = async (response: Response): Promise<Plan | undefined> => {
    const required = await paymentRequiredOf(response);
    const choice = required === undefined ? undefined : meterOffersOf(required)[0];
    if (required === undefined || choice === undefined) return undefined;
    const { offer, requirement } = choice;
    if (offer.price > options.maxPrice) throw new PriceTooHighError(offer, options.maxPrice);
    const meterId = await (options.meterFor ?? defaultMeterFor)(offer);
    if (meterId === undefined) throw new NoMeterError(offer);
    return { required, requirement, offer, meterId };
  };

  /** Refusals that mean the remembered offer or meter no longer holds, rather than a limit reached. */
  const STALE_PLAN = new Set<string>([
    METER_REASONS.unknownMeter,
    METER_REASONS.notOpen,
    METER_REASONS.wrongMerchant,
    METER_REASONS.wrongAsset,
    METER_REASONS.malformed,
  ]);

  const pay = async (original: Request, endpoint: string, plan: Plan, fromMemory: boolean): Promise<Response> => {
    const outcome = await attempt(original, endpoint, plan, fromMemory);
    if (!("restart" in outcome)) return outcome.response;
    // Outside the meter's queue: the new terms may well be on the same meter.
    const fresh = await planFor(outcome.restart);
    if (fresh === undefined) return outcome.restart;
    remembered.set(endpoint, fresh);
    return pay(original, endpoint, fresh, false);
  };

  const attempt = (original: Request, endpoint: string, plan: Plan, fromMemory: boolean): Promise<{ response: Response } | { restart: Response }> => {
    const { offer, requirement, required, meterId } = plan;
    const key = `${offer.chainId}:${offer.meter}:${meterId}`;
    return serial(key, async () => {
      for (let tries = 0; ; tries += 1) {
        const base = await acceptedTotal(offer, meterId, key, tries > 0);
        const total = base + offer.price;
        const issuedAt = BigInt(now());
        const signature: Hex = await options.signer.signTypedData(
          usageReceiptTypedData({
            domain: { name: offer.name, version: offer.version, chainId: offer.chainId, verifyingContract: offer.meter as Address },
            receipt: { meterId, total, issuedAt },
          }),
        );
        const payload = meterPaymentPayload({ requirement, payment: { meterId, total, issuedAt, signature }, resource: required.resource });
        const paid = original.clone();
        paid.headers.set(X402_HEADERS.paymentSignature, encodePaymentSignatureHeader(payload));
        const response = await fetchImpl(paid);

        if (response.status === 402) {
          const refusal = await paymentRequiredOf(response);
          if (refusal?.error === METER_REASONS.staleTotal && tries === 0) continue;
          if (!fromMemory) return { response };
          // Paid up front on what the endpoint asked before. If that no longer holds (a new price,
          // payee or meter), start over from this 402 as if it were the first answer.
          const current = refusal === undefined ? undefined : meterOffersOf(refusal)[0]?.offer;
          if (current !== undefined && sameOffer(current, offer) && !STALE_PLAN.has(refusal?.error ?? "")) return { response };
          remembered.delete(endpoint);
          return { restart: response };
        }
        remembered.set(endpoint, plan);
        const settlementHeader = response.headers.get(X402_HEADERS.paymentResponse);
        let settlement: SettleResponse | undefined;
        if (settlementHeader !== null) {
          try {
            settlement = decodePaymentResponseHeader(settlementHeader);
          } catch {
            settlement = undefined;
          }
        }
        // Only a settled payment moves the total; a failed request was not charged.
        if (settlement?.success === true) accepted.set(key, total);
        options.onPayment?.({ offer, meterId, total, url: original.url, ...(settlement === undefined ? {} : { settlement }) });
        return { response };
      }
    });
  };

  return async (input, init) => {
    const original = new Request(input, init);
    const endpoint = `${original.method} ${original.url}`;
    const known = remembered.get(endpoint);
    if (known !== undefined) return pay(original, endpoint, known, true);

    const first = await fetchImpl(original.clone());
    if (first.status !== 402) return first;
    const plan = await planFor(first);
    if (plan === undefined) return first;
    return pay(original, endpoint, plan, false);
  };
}
