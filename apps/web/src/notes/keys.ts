/**
 * Private notes: a second PRF namespace, and the crypto that uses it.
 *
 * The account keys come from the passkey's PRF at Mera's default salt. Notes come from the same
 * passkey at a salt of their own, `sha256("weir.prf.notes.v1")`, which gives 32 bytes unrelated to
 * the accounts: nothing here can sign for an account, and nothing that holds an account key can
 * read a note. Two keys are drawn from those bytes with HKDF, each under its own label:
 *
 * - an AES-256-GCM key, generated non-extractable, that seals the notes on this device;
 * - a 32-byte **locker**, one per network and hub, that names the sealed copy to Weir's API.
 *
 * The API stores the ciphertext under a hash of the locker. It never sees a note, a key, or which
 * payer a locker belongs to, and any device with the passkey finds the same locker again.
 */

import type { SaveNotesRequest, SealedNotes } from "@weir/shared";
import type { Address } from "viem";

import type { NotesKeys } from "../passkey/storage";

export const NOTES_NAMESPACE = "weir.prf.notes.v1";

const ENCRYPT_INFO = "weir.notes.encrypt.v1";
const LOCKER_INFO = "weir.notes.locker.v1";
const SEALED_WITH = new TextEncoder().encode("weir.notes.v1");
/** What one note may hold. */
export const NOTE_MAX = 200;

const encoder = new TextEncoder();

/** The notes namespace's PRF salt: 32 bytes, as WebAuthn requires. */
export async function notesPrfSalt(): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(NOTES_NAMESPACE)));
}

/** The notes keys for a PRF output at the notes salt. The PRF output is zeroed. */
export async function notesKeysFromPrfOutput(prfOutput: Uint8Array, scope: { chainId: number; hub: Address }): Promise<NotesKeys> {
  const bytes = new Uint8Array(prfOutput);
  prfOutput.fill(0);
  try {
    if (bytes.length !== 32) throw new RangeError(`A PRF output is 32 bytes, not ${bytes.length}`);
    const material = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey", "deriveBits"]);
    const hkdf = (info: string): HkdfParams => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(info) });
    const key = await crypto.subtle.deriveKey(hkdf(ENCRYPT_INFO), material, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const locker = await crypto.subtle.deriveBits(hkdf(`${LOCKER_INFO}:${scope.chainId}:${scope.hub.toLowerCase()}`), material, 256);
    return { key, locker: toHex(new Uint8Array(locker)) };
  } finally {
    bytes.fill(0);
  }
}

/** A payer's notes: the text for each mandate id. */
export type Notes = Readonly<Record<string, string>>;

export async function sealNotes(key: CryptoKey, notes: Notes): Promise<SaveNotesRequest> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify({ v: 1, notes }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: SEALED_WITH }, key, plain);
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(new Uint8Array(ciphertext)) };
}

/** The notes in a sealed copy. Throws when the key is not the one that sealed it. */
export async function openNotes(key: CryptoKey, sealed: SaveNotesRequest | SealedNotes): Promise<Notes> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(sealed.nonce), additionalData: SEALED_WITH },
    key,
    fromBase64Url(sealed.ciphertext),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as { v?: unknown; notes?: unknown };
  if (parsed.v !== 1 || typeof parsed.notes !== "object" || parsed.notes === null) throw new Error("Not a version 1 notes copy");
  return Object.fromEntries(
    Object.entries(parsed.notes as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/** `notes` with `text` for `mandateId`, or without it when the text is blank. */
export function withNote(notes: Notes, mandateId: string, text: string): Notes {
  const next: Record<string, string> = { ...notes };
  const trimmed = text.trim().slice(0, NOTE_MAX);
  if (trimmed === "") delete next[mandateId];
  else next[mandateId] = trimmed;
  return next;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
