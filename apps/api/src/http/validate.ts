/**
 * Strict readers for request bodies and path parameters.
 *
 * Each reader takes the raw JSON value and the field's path, and returns the typed value or throws
 * a 400 that names the path: `terms.maxTotal must be a decimal string of base units`. Objects
 * refuse keys they do not expect, so a client's typo is an error rather than a field silently
 * ignored.
 *
 * The bounds follow the contract. Amounts are `uint96` where `MandateHub` stores them, nonces and
 * permit values `uint256`, periods `uint32`, times `uint64`. Addresses are EIP-55: a mixed-case
 * address must carry a valid checksum, and a single-case one is checksummed on the way in, so
 * every address past this module compares by string equality.
 */

import { getAddress, isAddress, type Address, type Hex } from "viem";

import { badRequest } from "./errors.js";

export const MAX_UINT32 = 2n ** 32n - 1n;
export const MAX_UINT64 = 2n ** 64n - 1n;
export const MAX_UINT96 = 2n ** 96n - 1n;
export const MAX_UINT256 = 2n ** 256n - 1n;

export type Json = Readonly<Record<string, unknown>>;

/** A JSON object with no keys beyond `allowed`. */
export function readObject(value: unknown, path: string, allowed: readonly string[]): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`${path} must be a JSON object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw badRequest(`${path} has unexpected field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}`);
  }
  return value as Json;
}

const join = (path: string, key: string): string => (path === "body" ? key : `${path}.${key}`);

/** A 20-byte address, returned checksummed. */
export function readAddress(value: unknown, path: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw badRequest(`${path} must be a 20-byte 0x address`);
  }
  const hex = value.slice(2);
  const singleCase = hex === hex.toLowerCase() || hex === hex.toUpperCase();
  if (!singleCase && !isAddress(value, { strict: true })) {
    throw badRequest(`${path} has an invalid EIP-55 checksum`);
  }
  return getAddress(value);
}

/**
 * Base units as a decimal string, within `[min, max]`.
 *
 * A string because the wire contract says so: a JSON number loses precision past 2^53.
 */
export function readUnits(value: unknown, path: string, bounds: { min?: bigint; max?: bigint } = {}): bigint {
  const { min = 0n, max = MAX_UINT96 } = bounds;
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) {
    throw badRequest(`${path} must be a decimal string of base units`);
  }
  const parsed = BigInt(value);
  if (parsed < min) throw badRequest(`${path} must be at least ${min}`);
  if (parsed > max) throw badRequest(`${path} must be at most ${max}`);
  return parsed;
}

/** A non-negative integer sent as a JSON number, within `[min, max]` and the safe range. */
export function readInteger(value: unknown, path: string, bounds: { min?: number; max?: number } = {}): number {
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = bounds;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw badRequest(`${path} must be an integer`);
  }
  if (value < min) throw badRequest(`${path} must be at least ${min}`);
  if (value > max) throw badRequest(`${path} must be at most ${max}`);
  return value;
}

/** A signature deadline in unix seconds, strictly after `nowSeconds`. */
export function readDeadline(value: unknown, path: string, nowSeconds: number): number {
  const deadline = readInteger(value, path);
  if (deadline <= nowSeconds) throw badRequest(`${path} has passed; sign again with a later deadline`);
  return deadline;
}

/** Exactly 32 bytes of hex, returned lowercase. */
export function readBytes32(value: unknown, path: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw badRequest(`${path} must be 32 bytes of 0x hex`);
  }
  return value.toLowerCase() as Hex;
}

/**
 * A signature as 0x hex, `bytes` long within `[min, max]`.
 *
 * A mandate signature may come from a smart account (ERC-1271), which is why its ceiling is loose;
 * a permit signature goes through `permit(v, r, s)` and is exactly 65 bytes.
 */
export function readSignature(value: unknown, path: string, bytes: { min: number; max: number }): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw badRequest(`${path} must be 0x hex`);
  }
  const length = (value.length - 2) / 2;
  if (length < bytes.min || length > bytes.max) {
    throw badRequest(
      bytes.min === bytes.max
        ? `${path} must be ${bytes.min} bytes`
        : `${path} must be between ${bytes.min} and ${bytes.max} bytes`,
    );
  }
  return value.toLowerCase() as Hex;
}

/** A trimmed string of `[min, max]` characters. */
export function readText(value: unknown, path: string, bounds: { min?: number; max: number }): string {
  if (typeof value !== "string") throw badRequest(`${path} must be a string`);
  const text = value.trim();
  const { min = 0, max } = bounds;
  if (text.length < min) throw badRequest(min === 1 ? `${path} must not be empty` : `${path} must be at least ${min} characters`);
  if (text.length > max) throw badRequest(`${path} must be at most ${max} characters`);
  return text;
}

export function readOneOf<const T extends readonly string[]>(value: unknown, path: string, options: T): T[number] {
  if (typeof value !== "string" || !options.includes(value)) {
    throw badRequest(`${path} must be one of ${options.join(", ")}`);
  }
  return value as T[number];
}

export function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw badRequest(`${path} must be true or false`);
  return value;
}

/** Reads `body[key]` with `reader`, naming the field in any error. */
export function field<T>(body: Json, key: string, reader: (value: unknown, path: string) => T, parent = "body"): T {
  if (!(key in body) || body[key] === undefined) throw badRequest(`${join(parent, key)} is required`);
  return reader(body[key], join(parent, key));
}

/** As {@link field}, but `undefined` when the key is absent. */
export function optionalField<T>(
  body: Json,
  key: string,
  reader: (value: unknown, path: string) => T,
  parent = "body",
): T | undefined {
  if (!(key in body) || body[key] === undefined) return undefined;
  return reader(body[key], join(parent, key));
}
