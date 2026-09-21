/**
 * Naming a revert.
 *
 * A simulation that reverts is answered 422 `rejected_on_chain` with the custom error's name, so a
 * client can tell `SignatureExpired` from `NonceAlreadyUsed` without reading hex. The revert data
 * is found wherever viem's error chain carries it and decoded against the hub's errors and the
 * token's (which are also the savings vault's: both are OpenZeppelin ERC-20s with permit).
 * `Error(string)` and `Panic(uint256)` decode too, which covers a token such as USDC that reverts
 * with a string.
 */

import { mandateHubAbi, stablecoinAbi } from "@weir/shared";
import { decodeErrorResult, type Abi, type Hex } from "viem";

const REVERT_ABI: Abi = (() => {
  const seen = new Set<string>();
  const errors: Abi[number][] = [];
  for (const item of [...mandateHubAbi, ...stablecoinAbi]) {
    if (item.type !== "error" || seen.has(item.name)) continue;
    seen.add(item.name);
    errors.push(item);
  }
  return errors;
})();

export interface DecodedRevert {
  /** The custom error's name, `Error` for a string revert, or `unknown` when nothing decoded. */
  name: string;
  /** `Name(arg, ...)`, or a sentence when there was nothing to decode. */
  detail: string;
}

const HINTS: Readonly<Record<string, string>> = {
  InvalidSignature: "the signature does not verify for the claimed signer",
  SignatureExpired: "the signature's deadline has passed",
  NonceAlreadyUsed: "this signature was already used or its nonce was invalidated",
  InvalidAsset: "the hub does not accept this asset",
  InvalidVault: "the vault is not an ERC-4626 vault over the asset",
  InvalidMerchant: "the merchant is the zero address, the payer, or the hub",
  InvalidAmount: "the amount is zero",
  InvalidPeriod: "the period is outside 60 seconds to one year",
  InvalidChargeCap: "the per-charge cap is zero or below the periodic amount",
  InvalidTotalCap: "the lifetime cap cannot cover one charge",
  InvalidExpiry: "the expiry is not after now and after the first charge",
  UnknownMandate: "no mandate has that id",
  MandateIsCancelled: "the mandate is cancelled",
  MandateExpired: "the mandate has expired",
  MandateIsPaused: "the stream is already paused",
  MandateNotPaused: "the stream is not paused",
  NotStreaming: "only a streaming mandate can be paused or resumed",
  NotAuthorized: "the signer may not do this to this mandate",
  InvalidAction: "the action code is not cancel, pause or resume",
  ERC2612ExpiredSignature: "the permit's deadline has passed",
  ERC2612InvalidSigner: "the permit is not signed by its owner",
  InvalidAccountNonce: "the permit's nonce is stale",
};

function render(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  return JSON.stringify(value, (_key, inner: unknown) => (typeof inner === "bigint" ? inner.toString() : inner));
}

function asRevertData(value: unknown): Hex | undefined {
  if (typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value) && value.length >= 10) return value as Hex;
  return undefined;
}

/** The revert data anywhere in an error's cause chain, or `undefined`. */
export function findRevertData(error: unknown): Hex | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 12 && typeof current === "object" && current !== null; depth += 1) {
    const data = (current as { data?: unknown }).data;
    const found = asRevertData(data) ?? asRevertData((data as { data?: unknown } | undefined)?.data);
    if (found !== undefined) return found;
    // viem's decoded contract errors keep the raw bytes here.
    const raw = asRevertData((current as { raw?: unknown }).raw);
    if (raw !== undefined) return raw;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** True when the chain answered that the call reverts, as opposed to failing to answer at all. */
export function isRevert(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 12 && typeof current === "object" && current !== null; depth += 1) {
    const name = (current as { name?: unknown }).name;
    if (name === "ExecutionRevertedError" || name === "ContractFunctionRevertedError") return true;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && /execution reverted|revert/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return findRevertData(error) !== undefined;
}

/** The revert decoded, or `undefined` when `error` is not a revert. */
export function decodeRevert(error: unknown): DecodedRevert | undefined {
  const data = findRevertData(error);
  if (data === undefined) {
    return isRevert(error) ? { name: "unknown", detail: "the call reverts without a reason" } : undefined;
  }
  try {
    const decoded = decodeErrorResult({ abi: REVERT_ABI, data });
    const args = (decoded.args ?? []) as readonly unknown[];
    const call = `${decoded.errorName}(${args.map(render).join(", ")})`;
    const hint = HINTS[decoded.errorName];
    return { name: decoded.errorName, detail: hint === undefined ? call : `${call}: ${hint}` };
  } catch {
    return { name: "unknown", detail: `the call reverts with unrecognized data ${data.slice(0, 10)}` };
  }
}
