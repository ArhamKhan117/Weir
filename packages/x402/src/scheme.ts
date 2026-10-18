/**
 * `weir-meter`: an x402 payment scheme backed by a Weir metered mandate.
 *
 * x402's own `exact` scheme settles every request on chain, from a fresh signature over a token
 * transfer. `weir-meter` is for the many-small-requests case: the payer approves an API once with
 * a capped `MandateMeter` authorization, then signs a usage receipt per request (the running total
 * owed so far) with a key they already hold, usually the session key on their device or agent. The
 * receipt is free to sign and never touches the chain; the API's facilitator records it, and
 * settles the latest one on chain in batches, within the caps the payer signed.
 *
 * The wire is plain x402 V2: a `402` with `PAYMENT-REQUIRED` offering `weir-meter` (alongside any
 * other scheme the server takes), a retry with `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE` on the
 * paid response. This module is the scheme's vocabulary: the offer a server makes, the payment a
 * client sends, and strict readers for both, shared by the paywall, the paying fetch and the
 * facilitator so all three agree byte for byte.
 */

import type { PaymentPayload, PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { getAddress, isAddress, type Address, type Hex } from "viem";

export type { PaymentPayload, PaymentRequired, PaymentRequirements, ResourceInfo, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";

/** The protocol version spoken here. */
export const X402_VERSION = 2 as const;

/** The scheme name in `accepts[].scheme`. */
export const WEIR_METER_SCHEME = "weir-meter" as const;

/** The transport headers, as the x402 HTTP transport spells them. */
export const X402_HEADERS = {
  paymentRequired: "PAYMENT-REQUIRED",
  paymentSignature: "PAYMENT-SIGNATURE",
  paymentResponse: "PAYMENT-RESPONSE",
} as const;

/** Why a facilitator refused a payment, as `invalidReason` / `errorReason` carry it. */
export const METER_REASONS = {
  /** The receipt's total is not the last accepted total plus this request's price. */
  staleTotal: "weir_meter_stale_total",
  unknownMeter: "weir_meter_unknown",
  notOpen: "weir_meter_not_open",
  wrongMerchant: "weir_meter_wrong_merchant",
  wrongAsset: "weir_meter_wrong_asset",
  badSignature: "weir_meter_bad_signature",
  receiptTime: "weir_meter_receipt_time",
  periodCap: "weir_meter_period_cap",
  totalCap: "weir_meter_total_cap",
  unfunded: "weir_meter_unfunded",
  malformed: "weir_meter_malformed",
} as const;

export type MeterReason = (typeof METER_REASONS)[keyof typeof METER_REASONS];

/** A suggested authorization for a payer with no meter for this API yet. */
export interface SuggestedTerms {
  /** The most per period, base units. */
  periodCap: bigint;
  /** The period, seconds. */
  period: number;
  /** The most ever, base units. */
  maxTotal: bigint;
  /** How long the authorization lasts, seconds from approval. */
  termSeconds: number;
}

/** What a server asks for one request, in `weir-meter` terms. */
export interface MeterOffer {
  chainId: number;
  asset: Address;
  /** Who is paid: the API's payout address, a meter's `merchant`. */
  payTo: Address;
  /** This request's price, base units. */
  price: bigint;
  maxTimeoutSeconds: number;
  /** The `MandateMeter` contract. */
  meter: Address;
  /** The meter's EIP-712 domain name and version. */
  name: string;
  version: string;
  /** The facilitator's base URL: where receipts are verified and recorded. */
  facilitator: string;
  suggested?: SuggestedTerms;
}

/** What a client sends for one request: a signed running total on one meter. */
export interface MeterPayment {
  meterId: bigint;
  total: bigint;
  issuedAt: bigint;
  signature: Hex;
}

export class X402SchemeError extends Error {
  constructor(
    readonly reason: MeterReason,
    message: string,
  ) {
    super(message);
    this.name = "X402SchemeError";
  }
}

const malformed = (message: string) => new X402SchemeError(METER_REASONS.malformed, message);

export const networkOf = (chainId: number): `eip155:${number}` => `eip155:${chainId}`;

/** The chain id in a CAIP-2 `eip155:<id>` network. */
export function chainIdOf(network: string): number {
  const match = /^eip155:([0-9]{1,12})$/.exec(network);
  if (match === null || match[1] === undefined) throw malformed(`${network} is not an eip155 network`);
  return Number(match[1]);
}

const units = (value: bigint): string => value.toString();

function readUnits(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) throw malformed(`${path} must be a decimal string of base units`);
  return BigInt(value);
}

function readAddress(value: unknown, path: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw malformed(`${path} must be an address`);
  return getAddress(value);
}

function readPositiveInteger(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) throw malformed(`${path} must be a positive integer`);
  return value;
}

function readString(value: unknown, path: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw malformed(`${path} must be a non-empty string`);
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `accepts[]` entry for an offer. */
export function meterRequirement(offer: MeterOffer): PaymentRequirements {
  return {
    scheme: WEIR_METER_SCHEME,
    network: networkOf(offer.chainId),
    asset: offer.asset,
    amount: units(offer.price),
    payTo: offer.payTo,
    maxTimeoutSeconds: offer.maxTimeoutSeconds,
    extra: {
      meter: offer.meter,
      name: offer.name,
      version: offer.version,
      facilitator: offer.facilitator,
      ...(offer.suggested === undefined
        ? {}
        : {
            suggested: {
              periodCap: units(offer.suggested.periodCap),
              period: offer.suggested.period,
              maxTotal: units(offer.suggested.maxTotal),
              termSeconds: offer.suggested.termSeconds,
            },
          }),
    },
  };
}

/** An `accepts[]` entry read back as an offer. Throws {@link X402SchemeError} on anything else. */
export function readMeterRequirement(requirement: PaymentRequirements): MeterOffer {
  if (requirement.scheme !== WEIR_METER_SCHEME) throw malformed(`scheme ${requirement.scheme} is not ${WEIR_METER_SCHEME}`);
  const extra = requirement.extra;
  if (!isRecord(extra)) throw malformed("extra must be an object");
  const suggestedRaw = extra.suggested;
  let suggested: SuggestedTerms | undefined;
  if (suggestedRaw !== undefined) {
    if (!isRecord(suggestedRaw)) throw malformed("extra.suggested must be an object");
    suggested = {
      periodCap: readUnits(suggestedRaw.periodCap, "extra.suggested.periodCap"),
      period: readPositiveInteger(suggestedRaw.period, "extra.suggested.period"),
      maxTotal: readUnits(suggestedRaw.maxTotal, "extra.suggested.maxTotal"),
      termSeconds: readPositiveInteger(suggestedRaw.termSeconds, "extra.suggested.termSeconds"),
    };
  }
  const facilitator = readString(extra.facilitator, "extra.facilitator");
  if (!/^https?:\/\//.test(facilitator)) throw malformed("extra.facilitator must be an http(s) URL");
  return {
    chainId: chainIdOf(requirement.network),
    asset: readAddress(requirement.asset, "asset"),
    payTo: readAddress(requirement.payTo, "payTo"),
    price: readUnits(requirement.amount, "amount"),
    maxTimeoutSeconds: readPositiveInteger(requirement.maxTimeoutSeconds, "maxTimeoutSeconds", 86_400),
    meter: readAddress(extra.meter, "extra.meter"),
    name: readString(extra.name, "extra.name", 64),
    version: readString(extra.version, "extra.version", 16),
    facilitator: facilitator.replace(/\/+$/, ""),
    ...(suggested === undefined ? {} : { suggested }),
  };
}

/** Whether two offers ask for the same payment: what a server checks a client echoed back. */
export function sameOffer(a: MeterOffer, b: MeterOffer): boolean {
  return (
    a.chainId === b.chainId &&
    a.asset === b.asset &&
    a.payTo === b.payTo &&
    a.price === b.price &&
    a.meter === b.meter &&
    a.name === b.name &&
    a.version === b.version &&
    a.facilitator === b.facilitator
  );
}

/** The `payload` of a `PaymentPayload` for one request. */
export function meterPaymentPayload(input: {
  requirement: PaymentRequirements;
  payment: MeterPayment;
  resource?: ResourceInfo;
}): PaymentPayload {
  return {
    x402Version: X402_VERSION,
    ...(input.resource === undefined ? {} : { resource: input.resource }),
    accepted: input.requirement,
    payload: {
      meterId: input.payment.meterId.toString(),
      total: input.payment.total.toString(),
      issuedAt: Number(input.payment.issuedAt),
      signature: input.payment.signature,
    },
  };
}

/** The payment inside a `PaymentPayload.payload`. Throws {@link X402SchemeError} on anything else. */
export function readMeterPayment(payload: unknown): MeterPayment {
  if (!isRecord(payload)) throw malformed("payload must be an object");
  const signature = payload.signature;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{2,16384}$/.test(signature) || signature.length % 2 !== 0) {
    throw malformed("payload.signature must be hex bytes");
  }
  const issuedAt = payload.issuedAt;
  if (typeof issuedAt !== "number" || !Number.isInteger(issuedAt) || issuedAt < 0) throw malformed("payload.issuedAt must be unix seconds");
  return {
    meterId: readUnits(payload.meterId, "payload.meterId"),
    total: readUnits(payload.total, "payload.total"),
    issuedAt: BigInt(issuedAt),
    signature: signature as Hex,
  };
}
