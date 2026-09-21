/**
 * Relay request bodies, read strictly into the values the contract calls take.
 *
 * Bounds follow `IMandateHub`: amounts are `uint96`, `period` is `uint32`, `startAt` and
 * `expiresAt` are `uint64` (sent as JSON numbers, so within 2^53), nonces are `uint256` sent as
 * decimal strings. Deadlines must still be in the future when the request arrives, which turns an
 * expired signature into a free 400 rather than a simulation.
 */

import type { InstallRequest, MandateAction, MandateTerms, PayoutRequest, SavingsRequest, SignedPermit, WireTerms } from "@weir/shared";
import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";

import { badRequest } from "../http/errors.js";
import {
  field,
  optionalField,
  readAddress,
  readBytes32,
  readDeadline,
  readInteger,
  readObject,
  readOneOf,
  readSignature,
  readUnits,
  MAX_UINT256,
  MAX_UINT32,
  MAX_UINT96,
  type Json,
} from "../http/validate.js";

/** A mandate signature may come from a smart account, whose ERC-1271 signatures run long. */
export const MANDATE_SIGNATURE_BYTES = { min: 1, max: 8_192 } as const;
/** `permit(v, r, s)` takes an ECDSA signature and nothing else. */
export const PERMIT_SIGNATURE_BYTES = { min: 65, max: 65 } as const;

export interface PermitInput {
  token: Address;
  owner: Address;
  value: bigint;
  deadline: number;
  signature: Hex;
}

export interface InstallInput {
  permit?: PermitInput;
  /** A savings mandate's permit on its asset, the backup a charge falls back to. */
  backupPermit?: PermitInput;
  payer: Address;
  terms: MandateTerms;
  nonce: bigint;
  deadline: number;
  signature: Hex;
}

export interface ActionInput {
  mandateId: bigint;
  action: MandateAction;
  signer: Address;
  nonce: bigint;
  deadline: number;
  signature: Hex;
}

export interface SavingsInput {
  direction: "deposit" | "withdraw";
  owner: Address;
  asset: Address;
  amount: bigint;
  /** Withdrawals: the most shares the permit lets the router burn. */
  maxShares?: bigint;
  deadline: number;
  signature: Hex;
}

export interface PayoutInput {
  owner: Address;
  asset: Address;
  amount: bigint;
  to: Address;
  deadline: number;
  signature: Hex;
}

export interface SetManagerInput {
  mandateId: bigint;
  manager: Address;
  nonce: bigint;
  deadline: number;
  signature: Hex;
}

const readNonce = (value: unknown, path: string): bigint => readUnits(value, path, { max: MAX_UINT256 });
const readMandateId = (value: unknown, path: string): bigint => readUnits(value, path, { min: 1n, max: MAX_UINT256 });
const readAmount = (value: unknown, path: string): bigint => readUnits(value, path, { max: MAX_UINT96 });

function readPermit(value: unknown, path: string, nowSeconds: number): PermitInput {
  const body = readObject(value, path, ["token", "owner", "value", "deadline", "signature"] satisfies (keyof SignedPermit)[]);
  return {
    token: field(body, "token", readAddress, path),
    owner: field(body, "owner", readAddress, path),
    value: field(body, "value", (v, p) => readUnits(v, p, { max: MAX_UINT256 }), path),
    deadline: field(body, "deadline", (v, p) => readDeadline(v, p, nowSeconds), path),
    signature: field(body, "signature", (v, p) => readSignature(v, p, PERMIT_SIGNATURE_BYTES), path),
  };
}

const TERMS_FIELDS = [
  "merchant",
  "asset",
  "vault",
  "manager",
  "amount",
  "period",
  "startAt",
  "maxPerCharge",
  "maxTotal",
  "expiresAt",
  "ref",
] as const satisfies readonly (keyof WireTerms)[];

export function readTerms(value: unknown, path: string): MandateTerms {
  const body: Json = readObject(value, path, TERMS_FIELDS);
  return {
    merchant: field(body, "merchant", readAddress, path),
    asset: field(body, "asset", readAddress, path),
    vault: field(body, "vault", readAddress, path),
    manager: field(body, "manager", readAddress, path),
    amount: field(body, "amount", readAmount, path),
    period: field(body, "period", (v, p) => readInteger(v, p, { max: Number(MAX_UINT32) }), path),
    startAt: BigInt(field(body, "startAt", (v, p) => readInteger(v, p), path)),
    maxPerCharge: field(body, "maxPerCharge", readAmount, path),
    maxTotal: field(body, "maxTotal", readAmount, path),
    expiresAt: BigInt(field(body, "expiresAt", (v, p) => readInteger(v, p), path)),
    ref: field(body, "ref", readBytes32, path),
  };
}

export function parseInstall(value: unknown, nowSeconds: number): InstallInput {
  const body = readObject(
    value,
    "body",
    ["permit", "backupPermit", "payer", "terms", "nonce", "deadline", "signature"] satisfies (keyof InstallRequest)[],
  );
  const permit = optionalField(body, "permit", (v, p) => readPermit(v, p, nowSeconds));
  const backupPermit = optionalField(body, "backupPermit", (v, p) => readPermit(v, p, nowSeconds));
  return {
    ...(permit === undefined ? {} : { permit }),
    ...(backupPermit === undefined ? {} : { backupPermit }),
    payer: field(body, "payer", readAddress),
    terms: field(body, "terms", readTerms),
    nonce: field(body, "nonce", readNonce),
    deadline: field(body, "deadline", (v, p) => readDeadline(v, p, nowSeconds)),
    signature: field(body, "signature", (v, p) => readSignature(v, p, MANDATE_SIGNATURE_BYTES)),
  };
}

export function parseAction(value: unknown, nowSeconds: number): ActionInput {
  const body = readObject(value, "body", ["mandateId", "action", "signer", "nonce", "deadline", "signature"]);
  return {
    mandateId: field(body, "mandateId", readMandateId),
    action: field(body, "action", (v, p) => readOneOf(v, p, ["cancel", "pause", "resume"] as const)),
    signer: field(body, "signer", readAddress),
    nonce: field(body, "nonce", readNonce),
    deadline: field(body, "deadline", (v, p) => readDeadline(v, p, nowSeconds)),
    signature: field(body, "signature", (v, p) => readSignature(v, p, MANDATE_SIGNATURE_BYTES)),
  };
}

export function parseSetManager(value: unknown, nowSeconds: number): SetManagerInput {
  const body = readObject(value, "body", ["mandateId", "manager", "nonce", "deadline", "signature"]);
  return {
    mandateId: field(body, "mandateId", readMandateId),
    manager: field(body, "manager", readAddress),
    nonce: field(body, "nonce", readNonce),
    deadline: field(body, "deadline", (v, p) => readDeadline(v, p, nowSeconds)),
    signature: field(body, "signature", (v, p) => readSignature(v, p, MANDATE_SIGNATURE_BYTES)),
  };
}

export function parseSavings(value: unknown, nowSeconds: number): SavingsInput {
  const body = readObject(value, "body", [
    "direction",
    "owner",
    "asset",
    "amount",
    "maxShares",
    "deadline",
    "signature",
  ] satisfies (keyof SavingsRequest)[]);
  const direction = field(body, "direction", (v, p) => readOneOf(v, p, ["deposit", "withdraw"] as const));
  const maxShares = optionalField(body, "maxShares", (v, p) => readUnits(v, p, { min: 1n, max: MAX_UINT256 }));
  if (direction === "withdraw" && maxShares === undefined) throw badRequest("A withdrawal needs maxShares, the shares its permit covers");
  if (direction === "deposit" && maxShares !== undefined) throw badRequest("maxShares is for withdrawals only");
  return {
    direction,
    owner: field(body, "owner", readAddress),
    asset: field(body, "asset", readAddress),
    amount: field(body, "amount", (v, p) => readUnits(v, p, { min: 1n, max: MAX_UINT256 })),
    ...(maxShares === undefined ? {} : { maxShares }),
    deadline: field(body, "deadline", (v, p) => readDeadline(v, p, nowSeconds)),
    signature: field(body, "signature", (v, p) => readSignature(v, p, PERMIT_SIGNATURE_BYTES)),
  };
}

export function parsePayout(value: unknown, nowSeconds: number): PayoutInput {
  const body = readObject(value, "body", ["owner", "asset", "amount", "to", "deadline", "signature"] satisfies (keyof PayoutRequest)[]);
  const owner = field(body, "owner", readAddress);
  const to = field(body, "to", readAddress);
  if (isAddressEqual(to, zeroAddress) || isAddressEqual(to, owner)) throw badRequest("to must be another address than the paying wallet");
  return {
    owner,
    asset: field(body, "asset", readAddress),
    amount: field(body, "amount", (v, p) => readUnits(v, p, { min: 1n, max: MAX_UINT96 })),
    to,
    deadline: field(body, "deadline", (v, p) => readDeadline(v, p, nowSeconds)),
    signature: field(body, "signature", (v, p) => readSignature(v, p, PERMIT_SIGNATURE_BYTES)),
  };
}
