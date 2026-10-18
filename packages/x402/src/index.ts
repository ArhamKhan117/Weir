/**
 * `@weir/x402`: pay-per-request over x402, settled through Weir metered mandates.
 *
 * - {@link createPaywall}: put a price on any Fetch-API handler.
 * - {@link createMeterFetch}: a `fetch` that pays those prices from a meter, with no prompt.
 * - {@link weirMeter}: the meter and facilitator for a Monad network, from Weir's deployment record.
 */

export * from "./scheme.js";
export { createPaywall, type Paywall, type PaywallOptions } from "./server.js";
export {
  createMeterFetch,
  meterOffersOf,
  NoMeterError,
  PriceTooHighError,
  type MeterFetchOptions,
  type MeterPaymentEvent,
  type MeterSigner,
} from "./client.js";
export { FacilitatorError } from "./facilitator.js";
export { weirMeter, WEIR_FACILITATORS } from "./networks.js";
export {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
