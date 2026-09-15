/**
 * Failures the plugin names for the person or agent running it.
 *
 * Every failure carries a stable `code` an agent can branch on, a sentence saying what went wrong,
 * and a hint saying what to do next. The command boundary turns a {@link WeirError} into the
 * host's own error type, so the CLI prints it and exits non-zero like any built-in command.
 *
 * A relay the chain refuses comes back from the API as `rejected_on_chain` with the custom error's
 * name first, for example `MandateExpired(1790000000, 1790000100): the mandate has expired`.
 * {@link describeRefusal} turns that into "the hub refused it: MandateExpired" with the reason.
 */

export type WeirErrorCode =
  | "INVALID_INPUT"
  | "PLAN_NOT_FOUND"
  | "PLAN_INACTIVE"
  | "API_UNREACHABLE"
  | "API_ERROR"
  | "API_REFUSED"
  | "HUB_REFUSED"
  | "TOKEN_REFUSED"
  | "RATE_LIMITED"
  | "RELAYER_UNAVAILABLE"
  | "RECEIPT_PENDING"
  | "UNSUPPORTED_CHAIN"
  | "CHAIN_MISMATCH"
  | "RPC_FAILED"
  | "PERMIT_DOMAIN_UNKNOWN"
  | "NO_SAVINGS"
  | "INSUFFICIENT_FUNDS"
  | "MANDATE_NOT_FOUND"
  | "NOT_YOURS"
  | "ALREADY_STOPPED"
  | "NOT_A_STREAM"
  | "ALREADY_PAUSED"
  | "NOT_PAUSED"
  | "WALLET_MISSING"
  | "CAPABILITY_MISSING"
  | "SIGNING_FAILED"
  | "NOT_TESTNET";

export class WeirError extends Error {
  constructor(
    readonly code: WeirErrorCode,
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "WeirError";
  }
}

export function isWeirError(error: unknown): error is WeirError {
  return error instanceof WeirError;
}

/** The message of anything thrown, without its stack. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Custom errors a token or a vault raises when it refuses a permit, rather than the hub. */
const TOKEN_ERRORS = new Set([
  "ERC2612ExpiredSignature",
  "ERC2612InvalidSigner",
  "InvalidAccountNonce",
  "ERC20InsufficientAllowance",
  "ERC20InsufficientBalance",
  "ERC20InvalidSpender",
]);

/** What to do about each refusal, where there is something specific to do. */
const REFUSAL_HINTS: Readonly<Record<string, string>> = {
  SignatureExpired: "The signatures reached the relayer after their deadline. Run the command again to sign fresh ones.",
  ERC2612ExpiredSignature: "The permit reached the relayer after its deadline. Run the command again to sign a fresh one.",
  NonceAlreadyUsed: "That signature was already used. Run the command again to sign a fresh one.",
  InvalidAccountNonce: "Another permit from this wallet landed first. Run the command again to sign against the new nonce.",
  InvalidSignature: "The signature does not come from the address the request names. Check which wallet is selected with `mm wallet address`.",
  ERC2612InvalidSigner: "The permit does not come from its owner. Check which wallet is selected with `mm wallet address`.",
  NotAuthorized: "Only the mandate's payer or its manager can do that. See `mm weir list` for the mandates this wallet pays.",
  MandateIsCancelled: "It is already stopped; nothing more can be charged.",
  MandateExpired: "The mandate has passed its end date, so there is nothing left to change.",
  NotStreaming: "Pause and resume apply to per-second streams only. Stop a periodic mandate with `mm weir stop <id>`.",
  MandateIsPaused: "It is already paused. Resume it with `mm weir resume <id>`.",
  MandateNotPaused: "It is running. Pause it with `mm weir pause <id>`.",
  UnknownMandate: "No mandate has that id. See `mm weir list`.",
  InvalidAsset: "The hub does not accept this plan's asset. Tell the business its plan cannot be installed.",
  InvalidVault: "The savings vault does not hold this plan's asset. Subscribe without --from-savings.",
  InvalidExpiry: "The plan's term does not fit on chain. Tell the business its plan cannot be installed.",
};

/**
 * A plain sentence and a hint for an API `rejected_on_chain` message.
 *
 * The API leads with the custom error's name when the revert decodes, and with a sentence when it
 * does not, so anything that does not start with an identifier is passed through as the reason.
 */
export function describeRefusal(apiMessage: string): { code: "HUB_REFUSED" | "TOKEN_REFUSED"; message: string; hint: string } {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\))?(?::\s*(.*))?$/s.exec(apiMessage.trim());
  const name = match?.[1];
  if (match === null || name === undefined || name === "unknown" || name === "reverted") {
    return {
      code: "HUB_REFUSED",
      message: `the hub refused it: ${apiMessage}`,
      hint: "Nothing was changed. Check `mm weir list` and try again.",
    };
  }
  const reason = match[2]?.trim();
  const byToken = TOKEN_ERRORS.has(name);
  return {
    code: byToken ? "TOKEN_REFUSED" : "HUB_REFUSED",
    message: `${byToken ? "the token refused the permit" : "the hub refused it"}: ${name}${reason === undefined || reason === "" ? "" : ` (${reason})`}`,
    hint: REFUSAL_HINTS[name] ?? "Nothing was changed. Check `mm weir list` and try again.",
  };
}
