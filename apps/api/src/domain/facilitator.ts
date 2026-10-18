/**
 * The `weir-meter` facilitator: verifies a usage receipt for one request and, once the request
 * has been served, records it. Settlement on chain happens later, in batches (`meters/settler.ts`).
 *
 * A receipt is accepted when, all against the indexed meter and in this order:
 * - the offer is ours (this chain, this meter, its EIP-712 domain) and the payment echoes it;
 * - the meter pays the offer's payee in its asset, and is neither cancelled nor expired;
 * - the receipt was issued just now (within the offer's timeout, a few seconds of clock skew);
 * - it is signed by the meter's manager or payer (EOA or ERC-1271), checked before anything about
 *   the meter's usage is compared, so a stranger learns nothing of it;
 * - its total is exactly the last accepted total plus this request's price, so every request
 *   adds its price once and receipts chain;
 * - the new total stays within the lifetime cap, and this period's usage within the period cap;
 * - the payer's balance and allowance to the meter cover everything not yet settled.
 *
 * Recording is a compare-and-swap on the previous total, so of two requests racing on one meter
 * only one is accepted; the other is told its total is stale and re-signs.
 */

import { stablecoinAbi, usageReceiptTypedData, type MeterView } from "@weir/shared";
import {
  METER_REASONS,
  readMeterPayment,
  readMeterRequirement,
  sameOffer,
  WEIR_METER_SCHEME,
  X402_VERSION,
  X402SchemeError,
  type MeterOffer,
  type MeterPayment,
  type MeterReason,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "@weir/x402";
import { isAddressEqual, recoverTypedDataAddress, type Address, type PublicClient, type VerifyTypedDataParameters } from "viem";

import { periodStartAt, type MeterStore } from "../db/meters.js";

/** Seconds a receipt may be issued ahead of this server's clock. */
const CLOCK_SKEW_SECONDS = 5;
/** How long a payer's balance and allowance are trusted before they are read again. */
const FUNDS_TTL_MS = 10_000;

export interface FacilitatorOptions {
  chainId: number;
  meter: Address;
  /** The meter's EIP-712 domain. */
  name: string;
  version: string;
  assets: readonly Address[];
  store: MeterStore;
  /** ERC-1271 and ECDSA, for a signer that is not a plain key. */
  verifySignature: (args: VerifyTypedDataParameters) => Promise<boolean>;
  /** The payer's balance of `asset`, and their allowance to the meter. */
  funds: (asset: Address, owner: Address) => Promise<{ balance: bigint; allowance: bigint }>;
  /** Unix seconds. */
  now: () => number;
  /** The address that sends settlements on chain, when this API settles. */
  settler?: Address;
}

interface Checked {
  offer: MeterOffer;
  payment: MeterPayment;
  meter: MeterView;
  previous: bigint;
  periodStart: number;
  periodUsed: bigint;
  resource?: string;
}

type Outcome = { ok: true; checked: Checked } | { ok: false; reason: MeterReason; message: string };

const refuse = (reason: MeterReason, message: string): Outcome => ({ ok: false, reason, message });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The payer's funds, read from the chain with a short cache. */
export function chainFunds(client: PublicClient, meter: Address): FacilitatorOptions["funds"] {
  const cache = new Map<string, { at: number; value: Promise<{ balance: bigint; allowance: bigint }> }>();
  return (asset, owner) => {
    const key = `${asset}:${owner}`;
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < FUNDS_TTL_MS) return hit.value;
    const value = Promise.all([
      client.readContract({ address: asset, abi: stablecoinAbi, functionName: "balanceOf", args: [owner] }),
      client.readContract({ address: asset, abi: stablecoinAbi, functionName: "allowance", args: [owner, meter] }),
    ]).then(([balance, allowance]) => ({ balance, allowance }));
    value.catch(() => cache.delete(key));
    if (cache.size > 5_000) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return value;
  };
}

export class Facilitator {
  constructor(private readonly options: FacilitatorOptions) {}

  get network(): `eip155:${number}` {
    return `eip155:${this.options.chainId}`;
  }

  supported(): SupportedResponse {
    return {
      kinds: [
        {
          x402Version: X402_VERSION,
          scheme: WEIR_METER_SCHEME,
          network: this.network,
          extra: { meter: this.options.meter, name: this.options.name, version: this.options.version },
        },
      ],
      extensions: [],
      signers: this.options.settler === undefined ? {} : { [this.network]: [this.options.settler] },
    };
  }

  /** Reads `{ x402Version, paymentPayload, paymentRequirements }` and checks the receipt. */
  private async check(body: unknown): Promise<Outcome> {
    if (!isRecord(body) || body.x402Version !== X402_VERSION || !isRecord(body.paymentPayload) || !isRecord(body.paymentRequirements)) {
      return refuse(METER_REASONS.malformed, "Expected { x402Version: 2, paymentPayload, paymentRequirements }");
    }
    const payload = body.paymentPayload as unknown as PaymentPayload;
    const requirement = body.paymentRequirements as unknown as PaymentRequirements;

    let offer: MeterOffer;
    let payment: MeterPayment;
    try {
      if (payload.x402Version !== X402_VERSION) throw new X402SchemeError(METER_REASONS.malformed, "x402Version must be 2");
      offer = readMeterRequirement(requirement);
      if (!isRecord(payload.accepted) || !sameOffer(readMeterRequirement(payload.accepted), offer)) {
        throw new X402SchemeError(METER_REASONS.malformed, "The payment is not for the offer it is checked against");
      }
      payment = readMeterPayment(payload.payload);
    } catch (error) {
      if (error instanceof X402SchemeError) return refuse(error.reason, error.message);
      throw error;
    }

    const { chainId, meter: meterAddress, name, version } = this.options;
    if (offer.chainId !== chainId || offer.meter !== meterAddress) return refuse(METER_REASONS.malformed, "This facilitator serves another chain or meter");
    if (offer.name !== name || offer.version !== version) return refuse(METER_REASONS.malformed, "The offer names another EIP-712 domain");
    if (!this.options.assets.some((asset) => isAddressEqual(asset, offer.asset))) return refuse(METER_REASONS.wrongAsset, "The meter does not take that asset");

    const now = this.options.now();
    const meter = await this.options.store.meter(payment.meterId, now);
    if (meter === undefined) return refuse(METER_REASONS.unknownMeter, `Meter ${payment.meterId} is not known (yet)`);
    if (!isAddressEqual(meter.merchant, offer.payTo)) return refuse(METER_REASONS.wrongMerchant, "The meter pays someone else");
    if (!isAddressEqual(meter.asset, offer.asset)) return refuse(METER_REASONS.wrongAsset, "The meter pays in another asset");
    if (meter.status === "Cancelled" || meter.closedAt !== 0) return refuse(METER_REASONS.notOpen, "The meter was stopped");
    if (now > meter.expiresAt) return refuse(METER_REASONS.notOpen, "The meter has expired");

    const issuedAt = Number(payment.issuedAt);
    if (issuedAt > now + CLOCK_SKEW_SECONDS || issuedAt < now - offer.maxTimeoutSeconds || issuedAt > meter.expiresAt) {
      return refuse(METER_REASONS.receiptTime, "The receipt was not issued just now");
    }

    const typed = usageReceiptTypedData({
      domain: { name, version, chainId, verifyingContract: meterAddress },
      receipt: { meterId: payment.meterId, total: payment.total, issuedAt: payment.issuedAt },
    });
    let signed = false;
    try {
      const recovered = await recoverTypedDataAddress({ ...typed, signature: payment.signature });
      signed = isAddressEqual(recovered, meter.manager) || isAddressEqual(recovered, meter.payer);
    } catch {
      signed = false;
    }
    // A smart-account payer signs with ERC-1271, which only the chain can check.
    if (!signed) signed = await this.options.verifySignature({ address: meter.payer, ...typed, signature: payment.signature }).catch(() => false);
    if (!signed) return refuse(METER_REASONS.badSignature, "The receipt is not signed by the meter's payer or manager");

    const usage = await this.options.store.usage(payment.meterId);
    const charged = BigInt(meter.totalCharged);
    const previous = usage === undefined || usage.total < charged ? charged : usage.total;
    if (payment.total !== previous + offer.price) return refuse(METER_REASONS.staleTotal, METER_REASONS.staleTotal);
    if (payment.total > BigInt(meter.maxTotal)) return refuse(METER_REASONS.totalCap, "The meter's lifetime cap is reached");

    const periodStart = periodStartAt(meter.createdAt, meter.period, now);
    const used = usage !== undefined && usage.periodStart === periodStart ? usage.periodUsed : 0n;
    if (used + offer.price > BigInt(meter.periodCap)) return refuse(METER_REASONS.periodCap, "This period's cap is reached");

    const owed = payment.total - charged;
    const funds = await this.options.funds(meter.asset, meter.payer);
    if (funds.balance < owed || funds.allowance < owed) return refuse(METER_REASONS.unfunded, "The payer cannot cover this request");

    const resource = isRecord(payload.resource) && typeof payload.resource.url === "string" ? payload.resource.url.slice(0, 512) : undefined;
    return {
      ok: true,
      checked: { offer, payment, meter, previous, periodStart, periodUsed: used, ...(resource === undefined ? {} : { resource }) },
    };
  }

  async verify(body: unknown): Promise<VerifyResponse> {
    const outcome = await this.check(body);
    if (!outcome.ok) return { isValid: false, invalidReason: outcome.reason, invalidMessage: outcome.message };
    return { isValid: true, payer: outcome.checked.meter.payer };
  }

  async settle(body: unknown): Promise<SettleResponse> {
    const outcome = await this.check(body);
    if (!outcome.ok) return { success: false, errorReason: outcome.reason, errorMessage: outcome.message, transaction: "", network: this.network };
    const { offer, payment, meter, previous, periodStart, periodUsed, resource } = outcome.checked;
    const accepted = await this.options.store.accept({
      meterId: payment.meterId,
      previous,
      total: payment.total,
      amount: offer.price,
      issuedAt: payment.issuedAt,
      signature: payment.signature,
      periodStart,
      periodUsed: periodUsed + offer.price,
      ...(resource === undefined ? {} : { resource }),
      nowSeconds: this.options.now(),
    });
    if (!accepted) {
      return { success: false, errorReason: METER_REASONS.staleTotal, errorMessage: METER_REASONS.staleTotal, transaction: "", network: this.network };
    }
    // Deferred settlement: there is no transaction per request. The receipt is settled on chain
    // with the next batch; `extra` says where the meter stands.
    return {
      success: true,
      payer: meter.payer,
      transaction: "",
      network: this.network,
      amount: offer.price.toString(),
      extra: { scheme: WEIR_METER_SCHEME, meterId: payment.meterId.toString(), total: payment.total.toString(), settledOnChain: meter.totalCharged },
    };
  }
}
