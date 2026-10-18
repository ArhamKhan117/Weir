/**
 * Pay per request: approving an API that takes Weir over x402, and paying its requests.
 *
 * An API that takes Weir answers an unpaid request with HTTP 402 and a `weir-meter` offer: who is
 * paid, in what, and one request's price. Approving it is two signatures from the wallet, the same
 * shape as a subscription: an EIP-2612 permit to the meter for the lifetime cap, and the meter's
 * terms. Paying is one more signature per request, a usage receipt for the new running total,
 * which the API's facilitator records; Weir settles the totals on chain in batches. The wallet
 * needs no MON for any of it.
 */

import {
  meterAuthorizationTypedData,
  meterCancelTypedData,
  meterDomain,
  permitTypedData,
  randomNonce,
  refFromString,
  type CancelMeterRequest,
  type InstallMeterRequest,
  type InstallMeterResponse,
  type MeterTerms,
  type MeterView,
  type MonadChainId,
} from "@weir/shared";
import {
  createMeterFetch,
  decodePaymentRequiredHeader,
  meterOffersOf,
  NoMeterError,
  PriceTooHighError,
  X402_HEADERS,
  type MeterOffer,
  type MeterSigner,
  type PaymentRequired,
} from "@weir/x402";
import { isAddressEqual, maxUint256, type Address, type Hex } from "viem";

import type { Deps } from "./deps.js";
import { messageOf, WeirError } from "./errors.js";
import { chainOf } from "./settings.js";
import type { SignRequest, Signer } from "./signer.js";
import { SIGNATURE_WINDOW } from "./terms.js";
import { meterTitle, moneyExact, shortAddress } from "./words.js";

const DAY = 86_400;

/** The `weir-meter` offer an unpaid request to `url` comes back with. */
export async function readMeterOffer(fetchImpl: typeof fetch, url: string): Promise<{ offer: MeterOffer; description?: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new WeirError("API_UNREACHABLE", `${url} could not be reached: ${messageOf(error)}`, "Check the address and the network.");
  }
  if (response.status !== 402) {
    throw new WeirError("NO_OFFER", `${url} answered ${response.status}, not 402 Payment Required`, "Point it at an endpoint that charges with Weir pay-per-request.");
  }
  let required: PaymentRequired;
  try {
    const header = response.headers.get(X402_HEADERS.paymentRequired);
    required = header !== null ? decodePaymentRequiredHeader(header) : ((await response.json()) as PaymentRequired);
  } catch {
    throw new WeirError("NO_OFFER", `${url} sent a 402 this plugin cannot read`, "The API's x402 answer is malformed.");
  }
  const [first] = meterOffersOf(required);
  if (first === undefined) throw new WeirError("NO_OFFER", `${url} does not take Weir pay-per-request (weir-meter)`, "It may take another x402 scheme only.");
  return { offer: first.offer, ...(required.resource?.description === undefined ? {} : { description: required.resource.description }) };
}

export interface ApprovalPlan {
  url: string;
  offer: MeterOffer;
  description?: string;
  payer: Address;
  terms: MeterTerms;
  balance: bigint;
  permit: { value: bigint; deadline: number; request: SignRequest };
  authorization: { nonce: bigint; deadline: number; request: SignRequest };
}

export interface ApprovalInput {
  url: string;
  perDay?: bigint;
  total?: bigint;
  days?: number;
  /** Who signs receipts besides the payer: the wallet itself by default. */
  manager?: Address;
}

/** Reads the offer and the chain, and builds both signatures for `payer` to approve the API. */
export async function prepareApproval(deps: Deps, fetchImpl: typeof fetch, input: ApprovalInput, payer: Address): Promise<ApprovalPlan> {
  const { offer, description } = await readMeterOffer(fetchImpl, input.url);
  const chainId = chainOf(offer.chainId, deps.settings);
  const suggested = offer.suggested?.period === DAY ? offer.suggested : undefined;
  const perDay = input.perDay ?? suggested?.periodCap ?? offer.price * 1_000n;
  const total = input.total ?? suggested?.maxTotal ?? offer.price * 5_000n;
  const days = input.days ?? (suggested === undefined ? 30 : Math.max(1, Math.round(suggested.termSeconds / DAY)));
  if (perDay < offer.price) throw new WeirError("INVALID_INPUT", `--per-day must cover one request, ${moneyExact(offer.price)}`, "Raise --per-day.");
  if (total < perDay) throw new WeirError("INVALID_INPUT", "--total must be at least --per-day", "Raise --total or lower --per-day.");
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new WeirError("INVALID_INPUT", "--days must be 1 to 365", "Approve for fewer days.");

  const now = deps.now();
  const host = new URL(input.url).host;
  const terms: MeterTerms = {
    merchant: offer.payTo,
    asset: offer.asset,
    manager: input.manager ?? payer,
    periodCap: perDay,
    period: DAY,
    maxTotal: total,
    expiresAt: BigInt(now + days * DAY),
    ref: refFromString(new TextDecoder().decode(new TextEncoder().encode(host).slice(0, 32)).replace(/�+$/, "")),
  };
  const chain = deps.chain(chainId);
  const [allowed, permitDomain, permitNonce, balance] = await Promise.all([
    chain.allowance(offer.asset, payer, offer.meter),
    chain.permitDomain(offer.asset),
    chain.permitNonce(offer.asset, payer),
    chain.balanceOf(offer.asset, payer),
  ]);
  const deadline = now + SIGNATURE_WINDOW;
  const value = allowed + total > maxUint256 ? maxUint256 : allowed + total;
  const nonce = randomNonce();
  return {
    url: input.url,
    offer,
    ...(description === undefined ? {} : { description }),
    payer,
    terms,
    balance,
    permit: {
      value,
      deadline,
      request: {
        typedData: permitTypedData({ token: { address: offer.asset, permit: permitDomain }, chainId, owner: payer, spender: offer.meter, value, nonce: permitNonce, deadline: BigInt(deadline) }),
        summary: `Let Weir's meter draw up to ${moneyExact(total)} from this wallet, only for usage of ${host} that you sign for`,
      },
    },
    authorization: {
      nonce,
      deadline,
      request: {
        typedData: meterAuthorizationTypedData({
          domain: meterDomain({ name: offer.name, chainId, address: offer.meter }),
          payer,
          terms,
          nonce,
          deadline: BigInt(deadline),
        }),
        summary: `Approve ${host} for ${moneyExact(offer.price)} a request, at most ${moneyExact(perDay)} a day and ${moneyExact(total)} in all, for ${days} days`,
      },
    },
  };
}

/** The body of `POST /v1/relay/meter` for an approval and its two signatures. */
export function approvalRequest(plan: ApprovalPlan, permitSignature: Hex, signature: Hex): InstallMeterRequest {
  return {
    permit: { token: plan.terms.asset, owner: plan.payer, value: plan.permit.value.toString(), deadline: plan.permit.deadline, signature: permitSignature },
    payer: plan.payer,
    terms: {
      merchant: plan.terms.merchant,
      asset: plan.terms.asset,
      manager: plan.terms.manager,
      periodCap: plan.terms.periodCap.toString(),
      period: plan.terms.period,
      maxTotal: plan.terms.maxTotal.toString(),
      expiresAt: Number(plan.terms.expiresAt),
      ref: plan.terms.ref,
    },
    nonce: plan.authorization.nonce.toString(),
    deadline: plan.authorization.deadline,
    signature,
  };
}

export async function signApproval(plan: ApprovalPlan, signer: Signer): Promise<InstallMeterRequest> {
  const permitSignature = await signer.signTypedData(plan.permit.request);
  const signature = await signer.signTypedData(plan.authorization.request);
  return approvalRequest(plan, permitSignature, signature);
}

/** Has the API's relayer open the meter. The facilitator named in the offer is the Weir API. */
export async function openMeter(fetchImpl: typeof fetch, plan: ApprovalPlan, request: InstallMeterRequest): Promise<InstallMeterResponse> {
  const url = `${plan.offer.facilitator}/v1/relay/meter`;
  const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  const body = (await response.json().catch(() => ({}))) as InstallMeterResponse & { error?: { message?: string } };
  if (!response.ok) throw new WeirError("API_REFUSED", `The Weir API refused the approval: ${body.error?.message ?? response.status}`, "Check the limits and the wallet's balance, then run it again.");
  return body;
}

export interface PaidResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
  /** The request's price, when it was paid. */
  price?: bigint;
  /** The running total signed for it. */
  total?: bigint;
  meterId?: string;
}

/**
 * Makes one request to `url`, paying it from this wallet's meter for that API when it answers 402.
 * The receipt is signed by `signer`, the payer or the meter's manager.
 */
export async function paidFetch(
  fetchImpl: typeof fetch,
  signer: Signer,
  url: string,
  options: { maxPrice: bigint; method?: string; body?: string; contentType?: string },
): Promise<PaidResponse> {
  let paid: { price: bigint; total: bigint; meterId: bigint } | undefined;
  // The wallet signs through the host's executor, with a sentence it shows and records; the
  // paying fetch only ever asks it for usage receipts.
  const receipts = {
    address: signer.address,
    signTypedData: (typedData: { message: { meterId: bigint; total: bigint } }) =>
      signer.signTypedData({
        typedData: typedData as unknown as SignRequest["typedData"],
        summary: `Pay for one request to ${new URL(url).host}: the running total on meter ${typedData.message.meterId} becomes ${moneyExact(typedData.message.total)}`,
      }),
  } as unknown as MeterSigner;
  const pay = createMeterFetch({
    fetch: fetchImpl,
    maxPrice: options.maxPrice,
    signer: receipts,
    onPayment: (event) => {
      if (event.settlement?.success === true) paid = { price: event.offer.price, total: event.total, meterId: event.meterId };
    },
  });
  let response: Response;
  try {
    response = await pay(url, {
      method: options.method ?? "GET",
      ...(options.body === undefined ? {} : { body: options.body, headers: { "content-type": options.contentType ?? "application/json" } }),
    });
  } catch (error) {
    if (error instanceof NoMeterError) {
      throw new WeirError("NO_METER", `This wallet has no open Weir meter paying ${shortAddress(error.offer.payTo)}`, `Approve it first with \`mm weir approve ${url}\`.`);
    }
    if (error instanceof PriceTooHighError) {
      throw new WeirError("PRICE_TOO_HIGH", `${url} costs ${moneyExact(error.offer.price)} a request, above --max-price ${moneyExact(error.maxPrice)}`, "Raise --max-price if that price is fine.");
    }
    if (error instanceof WeirError) throw error;
    throw new WeirError("API_UNREACHABLE", `The request to ${url} failed: ${messageOf(error)}`, "Check the address and the network.");
  }
  if (response.status === 402) {
    let reason = "payment refused";
    try {
      const header = response.headers.get(X402_HEADERS.paymentRequired);
      reason = (header !== null ? decodePaymentRequiredHeader(header) : ((await response.clone().json()) as PaymentRequired)).error ?? reason;
    } catch {
      // The status says enough.
    }
    throw new WeirError("PAYMENT_REFUSED", `${url} refused the payment: ${reason}`, "A cap may be reached, the meter stopped, or the wallet short of funds; `mm weir list` shows its state.");
  }
  return {
    url,
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: await response.text(),
    ...(paid === undefined ? {} : { price: paid.price, total: paid.total, meterId: paid.meterId.toString() }),
  };
}

export interface MeterStopPlan {
  meter: MeterView;
  chainId: MonadChainId;
  signer: Address;
  role: "payer" | "manager";
  /** The API's host when the meter's `ref` names it, or the payee's short address. */
  title: string;
  nonce: bigint;
  deadline: number;
  request: SignRequest;
}

/**
 * Reads the meter from the Weir API, checks this wallet may stop it (as its payer or manager) and
 * that it is still open, and builds the `MeterCancel` the meter's `cancelWithSig` takes.
 */
export async function prepareMeterStop(deps: Deps, meterId: bigint, signer: Address): Promise<MeterStopPlan> {
  const [meter, health] = await Promise.all([deps.api.meter(meterId.toString()), deps.api.health()]);
  const chainId = chainOf(meter.chainId, deps.settings);
  const title = meterTitle(meter);
  const role = isAddressEqual(meter.payer, signer) ? "payer" : isAddressEqual(meter.manager, signer) ? "manager" : undefined;
  if (role === undefined) {
    throw new WeirError("NOT_YOURS", `Meter #${meterId} is paid by ${meter.payer}, and this wallet is neither its payer nor its manager`, "See `mm weir list` for this wallet's meters.");
  }
  if (meter.status === "Cancelled") throw new WeirError("ALREADY_STOPPED", `Meter #${meterId} for ${title} is already stopped`, "Nothing more can be paid from it.");
  // The meter is signed for under the same EIP-712 name as the hub.
  const domain = await deps.chain(chainId).hubDomain(health.hub);
  const nonce = randomNonce();
  const deadline = deps.now() + SIGNATURE_WINDOW;
  return {
    meter,
    chainId,
    signer,
    role,
    title,
    nonce,
    deadline,
    request: {
      typedData: meterCancelTypedData({
        domain: meterDomain({ name: String(domain.name), chainId, address: meter.meter }),
        meterId,
        nonce,
        deadline: BigInt(deadline),
      }),
      summary: `Stop paying ${title} from meter #${meterId}: requests already paid are still settled, nothing new is paid`,
    },
  };
}

export function meterStopRequest(plan: MeterStopPlan, signature: Hex): CancelMeterRequest {
  return { meterId: plan.meter.id, signer: plan.signer, nonce: plan.nonce.toString(), deadline: plan.deadline, signature };
}

/** Signs the stop with the wallet and has the relayer submit it. */
export async function stopMeter(deps: Deps, plan: MeterStopPlan, signer: Signer): Promise<Hex> {
  if (!isAddressEqual(signer.address, plan.signer)) {
    throw new WeirError("SIGNING_FAILED", `The stop was built for ${plan.signer} but the signer is ${signer.address}`, "Run the command again.");
  }
  const { transaction } = await deps.api.meterCancel(meterStopRequest(plan, await signer.signTypedData(plan.request)));
  return transaction;
}
