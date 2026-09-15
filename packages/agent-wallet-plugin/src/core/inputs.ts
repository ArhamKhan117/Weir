/**
 * Reading what a person or an agent types: a checkout link or plan id, a mandate id, a dollar
 * amount, an address. Each refuses anything else with a sentence saying what was expected.
 */

import { parseDollars } from "@weir/shared";
import { getAddress, isAddress, type Address } from "viem";

import { WeirError } from "./errors.js";

/** A plan id as the API mints it: `pln_` and 16 lowercase base32 characters. */
export const PLAN_ID_PATTERN = /^pln_[a-z2-7]{16}$/;

const PLAN_HINT = "A plan id looks like pln_ followed by 16 letters and digits; a checkout link ends in /c/<plan id>.";

/**
 * The plan id in a checkout link (`https://…/c/pln_…`, with any query or fragment), in the API's
 * own checkout URL (`…/v1/checkout/pln_…`), or given bare.
 */
export function parsePlanRef(input: string): string {
  const text = input.trim();
  if (PLAN_ID_PATTERN.test(text)) return text;

  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {
    url = undefined;
  }
  if (url !== undefined && (url.protocol === "http:" || url.protocol === "https:")) {
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    for (let i = 0; i < segments.length - 1; i += 1) {
      const marker = segments[i];
      const candidate = segments[i + 1] ?? "";
      if ((marker === "c" || marker === "checkout") && PLAN_ID_PATTERN.test(candidate)) return candidate;
    }
  }
  throw new WeirError("INVALID_INPUT", `"${input}" is not a Weir checkout link or plan id`, PLAN_HINT);
}

/** A mandate id: a positive whole number, optionally written `#12`. */
export function parseMandateId(input: string): bigint {
  const text = input.trim().replace(/^#/, "");
  if (!/^[1-9]\d{0,76}$/.test(text)) {
    throw new WeirError("INVALID_INPUT", `"${input}" is not a mandate id`, "A mandate id is a whole number such as 12. See `mm weir list`.");
  }
  return BigInt(text);
}

/** Dollars to base units, refusing zero and anything that is not a plain amount. */
export function parseAmount(input: string, flag: string): bigint {
  let units: bigint;
  try {
    units = parseDollars(input);
  } catch {
    throw new WeirError("INVALID_INPUT", `${flag} "${input}" is not a dollar amount`, "Write it like 25 or 12.50, with at most six decimals.");
  }
  if (units === 0n) throw new WeirError("INVALID_INPUT", `${flag} must be more than zero`, "Write it like 25 or 12.50.");
  return units;
}

/** An EVM address, returned checksummed. Mixed case must carry a valid checksum. */
export function parseAddress(input: string, flag: string): Address {
  const text = input.trim();
  if (!isAddress(text, { strict: false })) {
    throw new WeirError("INVALID_INPUT", `${flag} "${input}" is not an address`, "An address is 0x followed by 40 hex characters.");
  }
  const hex = text.slice(2);
  if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase() && !isAddress(text, { strict: true })) {
    throw new WeirError("INVALID_INPUT", `${flag} "${input}" has an invalid checksum`, "Copy the address again, or write it all in lowercase.");
  }
  return getAddress(text);
}
