/**
 * Family support circles: validation of a new circle, and of a supporter's name.
 *
 * A circle names one recipient, and every contribution to it is a mandate paying that recipient
 * directly, so the only thing a circle could be used to fake is who it pays. It is therefore
 * accepted only when the recipient signed it. A supporter's name is accepted only from the
 * mandate's payer or its manager, the session key that already stops and pauses it.
 */

import { localCurrency, SUPPORT_PERIODS, type CreateSupportRequest, type SupporterNameRequest } from "@weir/shared";
import type { Address, Hex } from "viem";

import { badRequest } from "../http/errors.js";
import {
  field,
  optionalField,
  readAddress,
  readDeadline,
  readInteger,
  readObject,
  readSignature,
  readText,
  readUnits,
  MAX_UINT256,
  MAX_UINT96,
} from "../http/validate.js";

export const MAX_SUPPORT_NAME = 60;
export const MAX_SUPPORT_NOTE = 280;
export const MAX_SUPPORTER_NAME = 40;
/** A circle's signature may come from a smart account, whose ERC-1271 signatures run long. */
const SIGNATURE_BYTES = { min: 1, max: 8_192 } as const;

const PERIODS: readonly number[] = Object.values(SUPPORT_PERIODS);

export interface ValidSupport {
  recipient: Address;
  name: string;
  note: string;
  /** ISO 4217, or "" for none. */
  currency: string;
  asset: Address;
  assetSymbol: string;
  period: number;
  goal: bigint;
  nonce: bigint;
  deadline: number;
  signature: Hex;
}

/**
 * The request's circle, when every field is in bounds and its asset is accepted. The signature is
 * checked by the caller, which holds the chain client.
 */
export function validateSupport(
  value: unknown,
  nowSeconds: number,
  symbolFor: (asset: Address) => string | undefined,
): ValidSupport {
  const body = readObject(value, "body", [
    "recipient",
    "name",
    "note",
    "currency",
    "asset",
    "period",
    "goal",
    "nonce",
    "deadline",
    "signature",
  ] satisfies (keyof CreateSupportRequest)[]);
  const asset = field(body, "asset", readAddress);
  const assetSymbol = symbolFor(asset);
  if (assetSymbol === undefined) throw badRequest("asset is not one the hub accepts");
  const period = field(body, "period", (v, p) => readInteger(v, p, { min: 1, max: 31_536_000 }));
  if (!PERIODS.includes(period)) throw badRequest("period must be a week (604800) or a month (2592000)");
  // Optional, so a client that predates local currencies still opens a circle (signed with "").
  const currency = optionalField(body, "currency", (v, p) => readText(v, p, { min: 0, max: 3 })) ?? "";
  if (currency !== "" && localCurrency(currency) === undefined) throw badRequest("currency is not one Weir shows");
  return {
    recipient: field(body, "recipient", readAddress),
    name: field(body, "name", (v, p) => readText(v, p, { min: 1, max: MAX_SUPPORT_NAME })),
    note: field(body, "note", (v, p) => readText(v, p, { min: 0, max: MAX_SUPPORT_NOTE })),
    currency,
    asset,
    assetSymbol,
    period,
    goal: field(body, "goal", (v, p) => readUnits(v, p, { max: MAX_UINT96 })),
    nonce: field(body, "nonce", (v, p) => readUnits(v, p, { max: MAX_UINT256 })),
    deadline: field(body, "deadline", (v, p) => readDeadline(v, p, nowSeconds)),
    signature: field(body, "signature", (v, p) => readSignature(v, p, SIGNATURE_BYTES)),
  };
}

export interface ValidSupporterName {
  name: string;
  signer: Address;
  deadline: number;
  signature: Hex;
}

export function validateSupporterName(value: unknown, nowSeconds: number): ValidSupporterName {
  const body = readObject(value, "body", ["name", "signer", "deadline", "signature"] satisfies (keyof SupporterNameRequest)[]);
  return {
    name: field(body, "name", (v, p) => readText(v, p, { min: 1, max: MAX_SUPPORTER_NAME })),
    signer: field(body, "signer", readAddress),
    deadline: field(body, "deadline", (v, p) => readDeadline(v, p, nowSeconds)),
    signature: field(body, "signature", (v, p) => readSignature(v, p, SIGNATURE_BYTES)),
  };
}
