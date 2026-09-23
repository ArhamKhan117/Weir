/**
 * Webhook signatures.
 *
 * Every delivery carries `Weir-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is
 * HMAC-SHA256, keyed with the merchant's webhook secret, over `<t>.<raw body>`: the timestamp, a
 * dot, then the body byte for byte as sent. Folding `t` into the MAC is what makes the timestamp
 * mean something: a receiver that rejects stale `t` values cannot be replayed an old delivery
 * with a fresh header. {@link verifyWebhookSignature} is the receiver's side, for tests and for
 * anyone porting it.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "Weir-Signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A fresh per-merchant secret: `whsec_` and 32 random bytes, base64url. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function mac(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function signWebhook(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${mac(secret, timestamp, body)}`;
}

/**
 * True when `header` carries a `v1` that matches `body` under `secret` and a `t` within
 * `toleranceSeconds` of `nowSeconds`. Constant-time in the comparison.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  nowSeconds: number,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  if (header === null || header === undefined) return false;
  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value !== undefined && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v1" && value !== undefined) candidates.push(value);
  }
  if (timestamp === undefined || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(mac(secret, timestamp, body), "hex");
  return candidates.some((candidate) => {
    if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
    return timingSafeEqual(Buffer.from(candidate, "hex"), expected);
  });
}
