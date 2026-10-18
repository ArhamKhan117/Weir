/**
 * The paywall: put `weir-meter` x402 in front of any handler that speaks the Fetch API (Hono,
 * Next.js route handlers, Bun, Deno, Cloudflare Workers, Node with `Request`/`Response`).
 *
 * The x402 order, exactly: no payment, a `402` with the offer; a payment, verified by the
 * facilitator first; then the handler runs; then, only for a response below 400, the payment is
 * settled, and the paid response carries `PAYMENT-RESPONSE`. A request that fails is never charged.
 *
 *   const paywall = createPaywall({ ...weirMeter(10143), price: 1000n, payTo: "0x..." });
 *   app.get("/quote", (c) => paywall(c.req.raw, () => quote(c)));
 */

import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import type { Address } from "viem";

import { postFacilitator } from "./facilitator.js";
import {
  meterRequirement,
  readMeterRequirement,
  sameOffer,
  X402_HEADERS,
  X402_VERSION,
  type MeterOffer,
  type SuggestedTerms,
} from "./scheme.js";

export interface PaywallOptions {
  chainId: number;
  /** The `MandateMeter` contract on that chain. */
  meter: Address;
  /** The meter's EIP-712 domain; Weir's deployments use "Weir", "1". */
  name: string;
  version: string;
  /** The facilitator's base URL, a Weir API. */
  facilitator: string;
  /** Where payments go. */
  payTo: Address;
  /** A dollar stablecoin the meter accepts. */
  asset: Address;
  /** This request's price in base units, or a function of the request. */
  price: bigint | ((request: Request) => bigint);
  /** Offered to payers with no meter for this API yet. */
  suggested?: SuggestedTerms;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  /**
   * The URL payers are told they are paying for. The request's own URL by default, which behind a
   * proxy that ends TLS (most hosts) reads `http://` and may name an internal host.
   */
  resourceUrl?: (request: Request) => string;
  fetch?: typeof fetch;
}

export type Paywall = (request: Request, handler: (request: Request) => Promise<Response> | Response) => Promise<Response>;

function paymentRequired(offer: MeterOffer, request: Request, options: PaywallOptions, error: string): Response {
  const body: PaymentRequired = {
    x402Version: X402_VERSION,
    error,
    resource: {
      url: options.resourceUrl?.(request) ?? request.url,
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
    },
    accepts: [meterRequirement(offer)],
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      [X402_HEADERS.paymentRequired]: encodePaymentRequiredHeader(body),
      "access-control-expose-headers": `${X402_HEADERS.paymentRequired}, ${X402_HEADERS.paymentResponse}`,
    },
  });
}

/** A response with the settlement attached, its body and status untouched. */
function withSettlement(response: Response, settlement: SettleResponse): Response {
  const headers = new Headers(response.headers);
  headers.set(X402_HEADERS.paymentResponse, encodePaymentResponseHeader(settlement));
  const exposed = headers.get("access-control-expose-headers");
  headers.set("access-control-expose-headers", exposed === null ? X402_HEADERS.paymentResponse : `${exposed}, ${X402_HEADERS.paymentResponse}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createPaywall(options: PaywallOptions): Paywall {
  const fetchImpl = options.fetch ?? fetch;
  const facilitator = options.facilitator.replace(/\/+$/, "");

  return async (request, handler) => {
    const offer: MeterOffer = {
      chainId: options.chainId,
      asset: options.asset,
      payTo: options.payTo,
      price: typeof options.price === "function" ? options.price(request) : options.price,
      maxTimeoutSeconds: options.maxTimeoutSeconds ?? 60,
      meter: options.meter,
      name: options.name,
      version: options.version,
      facilitator,
      ...(options.suggested === undefined ? {} : { suggested: options.suggested }),
    };

    const header = request.headers.get(X402_HEADERS.paymentSignature);
    if (header === null) return paymentRequired(offer, request, options, "Payment required");

    let payload: PaymentPayload;
    let requirement: PaymentRequirements;
    try {
      payload = decodePaymentSignatureHeader(header);
      if (payload.x402Version !== X402_VERSION) throw new Error("unsupported x402 version");
      requirement = meterRequirement(offer);
      if (!sameOffer(readMeterRequirement(payload.accepted), offer)) throw new Error("the payment is not for this offer");
    } catch (error) {
      return paymentRequired(offer, request, options, error instanceof Error ? error.message : "Invalid payment");
    }

    const body = { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: requirement };
    let verified: VerifyResponse;
    try {
      verified = await postFacilitator<VerifyResponse>(fetchImpl, `${facilitator}/v1/x402/verify`, body);
    } catch {
      return new Response(JSON.stringify({ error: "The payment facilitator is unreachable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    if (!verified.isValid) {
      return paymentRequired(offer, request, options, verified.invalidReason ?? verified.invalidMessage ?? "Payment refused");
    }

    const response = await handler(request);
    if (response.status >= 400) return response;

    let settled: SettleResponse;
    try {
      settled = await postFacilitator<SettleResponse>(fetchImpl, `${facilitator}/v1/x402/settle`, body);
    } catch {
      return new Response(JSON.stringify({ error: "The payment facilitator is unreachable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    if (!settled.success) {
      return paymentRequired(offer, request, options, settled.errorReason ?? settled.errorMessage ?? "Payment not settled");
    }
    return withSettlement(response, settled);
  };
}
