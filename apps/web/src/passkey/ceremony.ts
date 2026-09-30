/**
 * The two WebAuthn ceremonies, returning the PRF output or a sentence a person can act on.
 *
 * Mera throws a `MeraError` with a stable code when a ceremony fails. Each code becomes plain
 * words here, because "PRF_UNAVAILABLE" tells nobody what to do. Every prompt follows a press;
 * nothing here runs on page load.
 */

import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
} from "@category-labs/mera";

import { devCreate, devAssert, devKeysEnabled } from "./devkey";

export const RP_NAME = "Weir";

export type Ceremony<T> = { ok: true; value: T } | { ok: false; message: string; cancelled: boolean };

export interface PrfResult {
  credential: PasskeyCredentialMetadata;
  /** 32 bytes the caller zeroes. */
  prfOutput: Uint8Array;
}

/** The site the passkey belongs to: this host. */
export function relyingPartyId(): string {
  return window.location.hostname;
}

/** Whether this browser can run a passkey ceremony at all. */
export function passkeysAvailable(): boolean {
  if (devKeysEnabled()) return true;
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.create === "function"
  );
}

export async function createPasskey(label: string): Promise<Ceremony<PrfResult>> {
  if (devKeysEnabled()) return { ok: true, value: devCreate() };
  try {
    const created = await createPasskeyWithPrfOutput({
      rp: { id: relyingPartyId(), name: RP_NAME },
      user: { name: label, displayName: label },
    });
    const credential: PasskeyCredentialMetadata =
      created.transports === undefined
        ? { credentialId: created.credentialId }
        : { credentialId: created.credentialId, transports: created.transports };
    return { ok: true, value: { credential, prfOutput: created.prfOutput } };
  } catch (cause) {
    return describe(cause, "create");
  }
}

/** With a credential, the prompt is pinned to it; without one, the browser offers every passkey for this site. */
export async function assertPasskey(credential?: PasskeyCredentialMetadata): Promise<Ceremony<PrfResult>> {
  if (devKeysEnabled()) return { ok: true, value: devAssert() };
  try {
    const asserted = await getPasskeyPrfOutput({
      rpId: relyingPartyId(),
      ...(credential === undefined ? {} : { credential }),
    });
    return {
      ok: true,
      value: {
        credential: credential ?? { credentialId: asserted.credentialId },
        prfOutput: asserted.prfOutput,
      },
    };
  } catch (cause) {
    return describe(cause, "assert");
  }
}

function describe(cause: unknown, ceremony: "create" | "assert"): { ok: false; message: string; cancelled: boolean } {
  const verb = ceremony === "create" ? "created" : "used";
  if (isMeraError(cause)) {
    switch (cause.code) {
      case "PRF_UNAVAILABLE":
        return {
          ok: false,
          cancelled: false,
          message:
            "This passkey cannot hold a Weir account on this device. iCloud Keychain, Google Password Manager, 1Password and YubiKey all work; on desktop Chrome, save it to Google Password Manager.",
        };
      case "PASSKEY_OPERATION_FAILED":
        if (wasCancelled(cause.cause)) {
          return { ok: false, cancelled: true, message: "Cancelled. Nothing was created or signed." };
        }
        return {
          ok: false,
          cancelled: false,
          message: `Your browser refused the passkey${reason(cause.cause)}. Passkeys need a secure page and a passkey made on this site.`,
        };
      case "CRYPTO_UNAVAILABLE":
        return { ok: false, cancelled: false, message: "This page cannot use passkeys because it is not served securely." };
      default:
        return { ok: false, cancelled: false, message: `The passkey could not be ${verb}: ${cause.message}` };
    }
  }
  const message = cause instanceof Error && cause.message.trim() !== "" ? cause.message : "no reason was given";
  return { ok: false, cancelled: false, message: `The passkey could not be ${verb}: ${message}` };
}

function wasCancelled(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { name?: unknown }).name === "NotAllowedError";
}

function reason(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== "") return ` (${cause.message})`;
  return "";
}
