/**
 * Validation of a browser's request for reminders. The endpoint is where the push service takes
 * messages for that browser, always an https URL; the two keys are what messages are encrypted to.
 */

import type { PushSubscribeRequest } from "@weir/shared";
import type { Address, Hex } from "viem";

import type { PushSubscriptionRecord } from "../db/store.js";
import { badRequest } from "../http/errors.js";
import { field, readAddress, readDeadline, readObject, readSignature } from "../http/validate.js";

const MAX_ENDPOINT = 1_024;
/** A P-256 public key and a 16-byte secret, base64url: 87 and 22 characters, with room either way. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}={0,2}$/;
const SIGNATURE_BYTES = { min: 1, max: 8_192 } as const;

export function readPushEndpoint(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > MAX_ENDPOINT) throw badRequest(`${path} must be a push endpoint URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest(`${path} must be a push endpoint URL`);
  }
  if (url.protocol !== "https:") throw badRequest(`${path} must be an https URL`);
  return value;
}

function readKey(value: unknown, path: string): string {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) throw badRequest(`${path} must be a base64url key`);
  return value;
}

export interface ValidPushSubscription {
  payer: Address;
  signer: Address;
  subscription: PushSubscriptionRecord;
  deadline: number;
  signature: Hex;
}

export function validatePushSubscription(value: unknown, nowSeconds: number): ValidPushSubscription {
  const body = readObject(value, "body", ["payer", "signer", "subscription", "deadline", "signature"] satisfies (keyof PushSubscribeRequest)[]);
  const subscription = field(body, "subscription", (v, p) => readObject(v, p, ["endpoint", "keys", "expirationTime"]));
  const keys = field(subscription, "keys", (v, p) => readObject(v, p, ["p256dh", "auth"]), "subscription");
  return {
    payer: field(body, "payer", readAddress),
    signer: field(body, "signer", readAddress),
    subscription: {
      endpoint: field(subscription, "endpoint", readPushEndpoint, "subscription"),
      p256dh: field(keys, "p256dh", readKey, "subscription.keys"),
      auth: field(keys, "auth", readKey, "subscription.keys"),
    },
    deadline: field(body, "deadline", (v, p) => readDeadline(v, p, nowSeconds)),
    signature: field(body, "signature", (v, p) => readSignature(v, p, SIGNATURE_BYTES)),
  };
}
