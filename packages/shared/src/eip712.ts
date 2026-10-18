/**
 * The typed data a payer or manager signs, exactly as `MandateHub` hashes it.
 *
 * Every type string here must match the hub's `*_TYPEHASH` constants character for character; a
 * mismatch produces a signature the hub rejects as `InvalidSignature` and says nothing else. The
 * tests pin each one against the contract's own strings.
 *
 * Also here: the EIP-2612 `Permit` a token signs, so an install is two signatures and no
 * transaction from the payer.
 */

import type { TypedDataDomain } from "viem";

import type { PermitDomain } from "./chains.js";
import type { Address, Hex, MandateTerms, MeterTerms, UsageReceipt } from "./types.js";

/** The hub's EIP-712 domain version. */
export const HUB_DOMAIN_VERSION = "1";

/** Action codes for `actWithSig`, as `ACTION_*` in `IMandateHub.sol`. */
export const ACTIONS = { cancel: 1, pause: 2, resume: 3 } as const;
export type MandateAction = keyof typeof ACTIONS;

const TERMS_FIELDS = [
  { name: "merchant", type: "address" },
  { name: "asset", type: "address" },
  { name: "vault", type: "address" },
  { name: "manager", type: "address" },
  { name: "amount", type: "uint96" },
  { name: "period", type: "uint32" },
  { name: "startAt", type: "uint64" },
  { name: "maxPerCharge", type: "uint96" },
  { name: "maxTotal", type: "uint96" },
  { name: "expiresAt", type: "uint64" },
  { name: "ref", type: "bytes32" },
] as const;

export const MANDATE_TYPES = {
  Mandate: [
    { name: "payer", type: "address" },
    { name: "terms", type: "Terms" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Terms: TERMS_FIELDS,
} as const;

export const ACTION_TYPES = {
  MandateAction: [
    { name: "mandateId", type: "uint256" },
    { name: "action", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const SET_MANAGER_TYPES = {
  SetManager: [
    { name: "mandateId", type: "uint256" },
    { name: "manager", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** The hub's domain on a given chain. `name` is the product name it was deployed with. */
export function hubDomain(hub: { name: string; chainId: number; address: Address }): TypedDataDomain {
  return { name: hub.name, version: HUB_DOMAIN_VERSION, chainId: hub.chainId, verifyingContract: hub.address };
}

export function createMandateTypedData(input: {
  domain: TypedDataDomain;
  payer: Address;
  terms: MandateTerms;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: input.domain,
    types: MANDATE_TYPES,
    primaryType: "Mandate",
    message: {
      payer: input.payer,
      terms: {
        merchant: input.terms.merchant,
        asset: input.terms.asset,
        vault: input.terms.vault,
        manager: input.terms.manager,
        amount: input.terms.amount,
        period: input.terms.period,
        startAt: input.terms.startAt,
        maxPerCharge: input.terms.maxPerCharge,
        maxTotal: input.terms.maxTotal,
        expiresAt: input.terms.expiresAt,
        ref: input.terms.ref,
      },
      nonce: input.nonce,
      deadline: input.deadline,
    },
  } as const;
}

export function actionTypedData(input: {
  domain: TypedDataDomain;
  mandateId: bigint;
  action: MandateAction;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: input.domain,
    types: ACTION_TYPES,
    primaryType: "MandateAction",
    message: { mandateId: input.mandateId, action: ACTIONS[input.action], nonce: input.nonce, deadline: input.deadline },
  } as const;
}

export function setManagerTypedData(input: {
  domain: TypedDataDomain;
  mandateId: bigint;
  manager: Address;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: input.domain,
    types: SET_MANAGER_TYPES,
    primaryType: "SetManager",
    message: { mandateId: input.mandateId, manager: input.manager, nonce: input.nonce, deadline: input.deadline },
  } as const;
}

/** An EIP-2612 permit for `token`, under the token's own domain. */
export function permitTypedData(input: {
  token: { address: Address; permit: PermitDomain };
  chainId: number;
  owner: Address;
  spender: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: {
      ...(input.token.permit.name === undefined ? {} : { name: input.token.permit.name }),
      ...(input.token.permit.version === undefined ? {} : { version: input.token.permit.version }),
      chainId: input.chainId,
      verifyingContract: input.token.address,
    },
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: {
      owner: input.owner,
      spender: input.spender,
      value: input.value,
      nonce: input.nonce,
      deadline: input.deadline,
    },
  } as const;
}

/*//////////////////////////////////////////////////////////////
                              THE METER
//////////////////////////////////////////////////////////////*/

// `MandateMeter`'s types, matching its `*_TYPEHASH` constants character for character.

export const METER_AUTHORIZATION_TYPES = {
  MeterAuthorization: [
    { name: "payer", type: "address" },
    { name: "terms", type: "MeterTerms" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  MeterTerms: [
    { name: "merchant", type: "address" },
    { name: "asset", type: "address" },
    { name: "manager", type: "address" },
    { name: "periodCap", type: "uint96" },
    { name: "period", type: "uint32" },
    { name: "maxTotal", type: "uint96" },
    { name: "expiresAt", type: "uint64" },
    { name: "ref", type: "bytes32" },
  ],
} as const;

export const USAGE_RECEIPT_TYPES = {
  UsageReceipt: [
    { name: "meterId", type: "uint256" },
    { name: "total", type: "uint96" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

export const METER_CANCEL_TYPES = {
  MeterCancel: [
    { name: "meterId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** The meter's domain on a given chain: the same name and version as the hub, its own address. */
export function meterDomain(meter: { name: string; chainId: number; address: Address }): TypedDataDomain {
  return { name: meter.name, version: HUB_DOMAIN_VERSION, chainId: meter.chainId, verifyingContract: meter.address };
}

export function meterAuthorizationTypedData(input: {
  domain: TypedDataDomain;
  payer: Address;
  terms: MeterTerms;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: input.domain,
    types: METER_AUTHORIZATION_TYPES,
    primaryType: "MeterAuthorization",
    message: {
      payer: input.payer,
      terms: {
        merchant: input.terms.merchant,
        asset: input.terms.asset,
        manager: input.terms.manager,
        periodCap: input.terms.periodCap,
        period: input.terms.period,
        maxTotal: input.terms.maxTotal,
        expiresAt: input.terms.expiresAt,
        ref: input.terms.ref,
      },
      nonce: input.nonce,
      deadline: input.deadline,
    },
  } as const;
}

/** A usage receipt, signed by the meter's payer or manager for every paid request. */
export function usageReceiptTypedData(input: { domain: TypedDataDomain; receipt: UsageReceipt }) {
  return {
    domain: input.domain,
    types: USAGE_RECEIPT_TYPES,
    primaryType: "UsageReceipt",
    message: { meterId: input.receipt.meterId, total: input.receipt.total, issuedAt: input.receipt.issuedAt },
  } as const;
}

export function meterCancelTypedData(input: { domain: TypedDataDomain; meterId: bigint; nonce: bigint; deadline: bigint }) {
  return {
    domain: input.domain,
    types: METER_CANCEL_TYPES,
    primaryType: "MeterCancel",
    message: { meterId: input.meterId, nonce: input.nonce, deadline: input.deadline },
  } as const;
}

/**
 * A fresh unordered nonce. The hub keeps one nonce namespace per signer and accepts them in any
 * order, so 256 random bits never collide and two checkouts signed at once both work.
 */
export function randomNonce(): bigint {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** A 32-byte `ref` from a short merchant string such as a plan id, right-padded with zeros. */
export function refFromString(text: string): Hex {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 32) throw new RangeError(`A ref is at most 32 bytes; "${text}" is ${bytes.length}`);
  let hex = "0x";
  for (let i = 0; i < 32; i++) hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  return hex as Hex;
}

/*//////////////////////////////////////////////////////////////
                         OFF-CHAIN MESSAGES
//////////////////////////////////////////////////////////////*/

/**
 * The domain of Weir's off-chain messages, which the API verifies and no contract does. It names
 * no contract, and its types share no name with the hub's, so no signature here means anything
 * on chain.
 */
export function messageDomain(chainId: number) {
  return { name: "Weir", version: HUB_DOMAIN_VERSION, chainId } as const;
}

const SUPPORT_CIRCLE_TYPES = {
  SupportCircle: [
    { name: "recipient", type: "address" },
    { name: "name", type: "string" },
    { name: "note", type: "string" },
    { name: "currency", type: "string" },
    { name: "asset", type: "address" },
    { name: "period", type: "uint32" },
    { name: "goal", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** A support circle, signed by its recipient: they are the only person who can open one for themselves. */
export function supportCircleTypedData(input: {
  chainId: number;
  recipient: Address;
  name: string;
  note: string;
  currency: string;
  asset: Address;
  period: number;
  goal: bigint;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: messageDomain(input.chainId),
    types: SUPPORT_CIRCLE_TYPES,
    primaryType: "SupportCircle",
    message: {
      recipient: input.recipient,
      name: input.name,
      note: input.note,
      currency: input.currency,
      asset: input.asset,
      period: input.period,
      goal: input.goal,
      nonce: input.nonce,
      deadline: input.deadline,
    },
  } as const;
}

const SUPPORTER_NAME_TYPES = {
  SupporterName: [
    { name: "hub", type: "address" },
    { name: "mandateId", type: "uint256" },
    { name: "name", type: "string" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** The name a supporter shows the person they support, signed by the mandate's payer or manager. */
export function supporterNameTypedData(input: { chainId: number; hub: Address; mandateId: bigint; name: string; deadline: bigint }) {
  return {
    domain: messageDomain(input.chainId),
    types: SUPPORTER_NAME_TYPES,
    primaryType: "SupporterName",
    message: { hub: input.hub, mandateId: input.mandateId, name: input.name, deadline: input.deadline },
  } as const;
}

const PUSH_SUBSCRIPTION_TYPES = {
  PushSubscription: [
    { name: "payer", type: "address" },
    { name: "endpoint", type: "string" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** A browser asking for `payer`'s reminders, signed by the payer or their session key. */
export function pushSubscriptionTypedData(input: { chainId: number; payer: Address; endpoint: string; deadline: bigint }) {
  return {
    domain: messageDomain(input.chainId),
    types: PUSH_SUBSCRIPTION_TYPES,
    primaryType: "PushSubscription",
    message: { payer: input.payer, endpoint: input.endpoint, deadline: input.deadline },
  } as const;
}
