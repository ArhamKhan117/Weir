/**
 * Pay-per-request: approving an API once, paying its requests with no prompt, and stopping it.
 *
 * Approving is two signatures from the owner key under one passkey prompt: an EIP-2612 permit
 * letting the meter pull up to the lifetime cap, and the meter's terms, with the session key on
 * this device as the manager. Every request after that is a usage receipt the session key signs,
 * with no prompt and no transaction; stopping is one more signature from the session key.
 */

import {
  meterAuthorizationTypedData,
  meterCancelTypedData,
  meterDomain,
  permitTypedData,
  meterRefForHost,
  randomNonce,
  textOfRef,
  type MeterTerms,
} from "@weir/shared";
import {
  createMeterFetch,
  decodePaymentRequiredHeader,
  meterOffersOf,
  X402_HEADERS,
  type MeterOffer,
  type MeterPaymentEvent,
  type PaymentRequired,
} from "@weir/x402";
import { getAddress, maxUint256, type Address, type Hex, type LocalAccount } from "viem";

import { api } from "./api";
import { allowance, permitNonce } from "./chain";
import { CHAIN_ID, DEPLOYMENT } from "./config";
import { SIGNATURE_WINDOW } from "./mandate";
import { permitDomainFor } from "./permit";

/** The meter on this network, when one is deployed. */
export const METER: Address | undefined = DEPLOYMENT.contracts.MandateMeter;

/** The most one request may cost before the app refuses to pay it: a dollar. */
export const MAX_PRICE = 1_000_000n;

const DAY = 86_400;

/** The paid demo API on this network: today's dollar rate for a currency. */
export function demoUrl(apiBase: string, currency = "PKR"): string {
  return `${apiBase.replace(/\/+$/, "")}/demo/fx?to=${currency}`;
}

export interface Offer {
  url: string;
  offer: MeterOffer;
  description?: string;
}

/**
 * What an API asks for a request: the first `weir-meter` offer in its 402, or why there is none.
 * The request is a plain GET with no payment, so it costs nothing.
 */
export async function readOffer(url: string): Promise<Offer> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET" });
  } catch {
    throw new Error("That address could not be reached from this browser.");
  }
  if (response.status !== 402) throw new Error(`That API did not ask for a payment (it answered ${response.status}).`);
  let required: PaymentRequired;
  const header = response.headers.get(X402_HEADERS.paymentRequired);
  try {
    required = header !== null ? decodePaymentRequiredHeader(header) : ((await response.json()) as PaymentRequired);
  } catch {
    throw new Error("That API's payment request could not be read.");
  }
  const [first] = meterOffersOf(required);
  if (first === undefined) throw new Error("That API does not take Weir pay-per-request.");
  if (first.offer.chainId !== CHAIN_ID) throw new Error("That API takes payment on the other Monad network. Switch networks in the header.");
  if (METER === undefined || getAddress(first.offer.meter) !== getAddress(METER)) throw new Error("That API names a meter this app does not know.");
  return { url, offer: first.offer, ...(required.resource.description === undefined ? {} : { description: required.resource.description }) };
}

/** The caps a payer approves: what the API suggests, or a modest default. */
export function defaultCaps(offer: MeterOffer): { perDay: bigint; total: bigint; days: number } {
  const suggested = offer.suggested;
  if (suggested !== undefined && suggested.period === DAY) {
    return { perDay: suggested.periodCap, total: suggested.maxTotal, days: Math.max(1, Math.round(suggested.termSeconds / DAY)) };
  }
  // A thousand requests a day, five thousand in all, for thirty days.
  return { perDay: offer.price * 1_000n, total: offer.price * 5_000n, days: 30 };
}

/** The name a meter's `ref` carries: the host of the API it pays. */
export function meterName(ref: Hex): string | undefined {
  return textOfRef(ref);
}

export function meterTermsFor(
  offer: MeterOffer,
  caps: { perDay: bigint; total: bigint; days: number },
  manager: Address,
  apiUrl: string,
  now = Math.floor(Date.now() / 1000),
): MeterTerms {
  return {
    merchant: offer.payTo,
    asset: offer.asset,
    manager,
    periodCap: caps.perDay,
    period: DAY,
    maxTotal: caps.total,
    expiresAt: BigInt(now + caps.days * DAY),
    ref: meterRefForHost(new URL(apiUrl, window.location.href).host),
  };
}

/**
 * Signs the permit and the meter's terms with the owner key, then has the relayer submit both in
 * one transaction. Returns the new meter's id.
 */
export async function signAndOpenMeter(owner: LocalAccount, terms: MeterTerms): Promise<{ meterId: string; transaction: Hex }> {
  if (METER === undefined) throw new Error("There is no meter on this network.");
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + SIGNATURE_WINDOW;
  const [current, domain, nonceValue] = await Promise.all([
    allowance(terms.asset, owner.address, METER),
    permitDomainFor(terms.asset),
    permitNonce(terms.asset, owner.address),
  ]);
  // One allowance serves every meter on the asset, so this one's cap goes on top of what is there.
  const value = current + terms.maxTotal > maxUint256 ? maxUint256 : current + terms.maxTotal;
  const permitSignature = await owner.signTypedData(
    permitTypedData({
      token: { address: terms.asset, permit: domain },
      chainId: CHAIN_ID,
      owner: owner.address,
      spender: METER,
      value,
      nonce: nonceValue,
      deadline: BigInt(deadline),
    }),
  );
  const nonce = randomNonce();
  const signature = await owner.signTypedData(
    meterAuthorizationTypedData({
      domain: meterDomain({ name: DEPLOYMENT.eip712.name, chainId: CHAIN_ID, address: METER }),
      payer: owner.address,
      terms,
      nonce,
      deadline: BigInt(deadline),
    }),
  );
  const response = await api.installMeter({
    permit: { token: terms.asset, owner: owner.address, value: value.toString(), deadline, signature: permitSignature },
    payer: owner.address,
    terms: {
      merchant: terms.merchant,
      asset: terms.asset,
      manager: terms.manager,
      periodCap: terms.periodCap.toString(),
      period: terms.period,
      maxTotal: terms.maxTotal.toString(),
      expiresAt: Number(terms.expiresAt),
      ref: terms.ref,
    },
    nonce: nonce.toString(),
    deadline,
    signature,
  });
  return { meterId: response.meterId, transaction: response.transactions.create };
}

/** Stops a meter with `signer`, the session key, and has the relayer submit it. */
export async function signAndStopMeter(signer: LocalAccount, meterId: string): Promise<Hex> {
  if (METER === undefined) throw new Error("There is no meter on this network.");
  const nonce = randomNonce();
  const deadline = Math.floor(Date.now() / 1000) + SIGNATURE_WINDOW;
  const signature = await signer.signTypedData(
    meterCancelTypedData({
      domain: meterDomain({ name: DEPLOYMENT.eip712.name, chainId: CHAIN_ID, address: METER }),
      meterId: BigInt(meterId),
      nonce,
      deadline: BigInt(deadline),
    }),
  );
  const response = await api.cancelMeter({ meterId, signer: getAddress(signer.address), nonce: nonce.toString(), deadline, signature });
  return response.transaction;
}

/** A fetch that pays `weir-meter` offers from the session key, with no prompt. */
export function payingFetch(session: LocalAccount, onPayment?: (event: MeterPaymentEvent) => void): typeof fetch {
  const pay = createMeterFetch({ signer: session, maxPrice: MAX_PRICE, ...(onPayment === undefined ? {} : { onPayment }) });
  return (input, init) => pay(input instanceof Request ? input : String(input), init);
}
