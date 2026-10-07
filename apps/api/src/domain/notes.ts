/**
 * Validation for private notes. The API never sees a note: it keeps one sealed blob per locker and
 * checks only its shape and size. The locker is a 32-byte secret the browser derives from the
 * payer's passkey; the server stores its SHA-256, so the table cannot be used to write to a locker.
 */

import { createHash } from "node:crypto";

import type { SaveNotesRequest } from "@weir/shared";

import { badRequest, unauthorized } from "../http/errors.js";
import { field, readObject } from "../http/validate.js";

const LOCKER_HEADER = /^Locker ([0-9a-f]{64})$/;
/** 12 bytes, base64url without padding. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** About 36 KiB of notes once sealed, inside the 64 KiB body limit. */
export const MAX_CIPHERTEXT = 48_000;
/** AES-GCM's 16-byte tag plus at least one byte, base64url. */
const MIN_CIPHERTEXT = 23;

/** The stored key for the locker in an `Authorization: Locker <hex>` header. */
export function lockerFrom(header: string | undefined): string {
  const match = header === undefined ? null : LOCKER_HEADER.exec(header);
  if (match === null) throw unauthorized("Private notes need an Authorization: Locker header");
  return createHash("sha256").update(Buffer.from(match[1]!, "hex")).digest("hex");
}

function readNonce(value: unknown, path: string): string {
  if (typeof value !== "string" || !NONCE_PATTERN.test(value)) throw badRequest(`${path} must be 12 bytes of base64url`);
  return value;
}

function readCiphertext(value: unknown, path: string): string {
  const ok = typeof value === "string" && value.length >= MIN_CIPHERTEXT && value.length <= MAX_CIPHERTEXT && BASE64URL.test(value);
  if (!ok) throw badRequest(`${path} must be base64url of at most ${MAX_CIPHERTEXT} characters`);
  return value as string;
}

export function validateNotes(body: unknown): SaveNotesRequest {
  const object = readObject(body, "body", ["nonce", "ciphertext"]);
  return { nonce: field(object, "nonce", readNonce), ciphertext: field(object, "ciphertext", readCiphertext) };
}
