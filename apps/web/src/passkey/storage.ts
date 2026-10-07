/**
 * What this device remembers about a Weir account, and where.
 *
 * - **The record** (local storage): which passkey, and the two addresses. No key material.
 * - **The session key** (IndexedDB): encrypted with an AES-GCM key that was generated as
 *   non-extractable and is stored as a `CryptoKey`, so script on the page can use it to decrypt
 *   but no code can read the wrapping key out. The session key is re-derivable from the passkey
 *   at any time, so losing this store costs one passkey prompt, never an account.
 *
 * - **The notes keys** (IndexedDB): the key that seals the payer's private notes, also a
 *   non-extractable `CryptoKey`, and the locker that names them to the API. They come from a PRF
 *   namespace of their own (`notes/keys.ts`), unrelated to the account keys.
 *
 * The owner key is never stored anywhere.
 */

import type { PasskeyCredentialMetadata } from "@category-labs/mera";
import type { Address } from "viem";

const RECORD_KEY = "weir.account.v1";
const DB_NAME = "weir";
const STORE = "keys";
const WRAP_KEY_ID = "wrap";

export interface AccountRecord {
  version: 1;
  credential: PasskeyCredentialMetadata;
  owner: Address;
  session: Address;
  createdAt: number;
  dev: boolean;
}

function isAddressText(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function readRecord(): AccountRecord | undefined {
  try {
    const raw = window.localStorage.getItem(RECORD_KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<AccountRecord>;
    if (parsed.version !== 1 || typeof parsed.credential?.credentialId !== "string") return undefined;
    if (!isAddressText(parsed.owner) || !isAddressText(parsed.session)) return undefined;
    return {
      version: 1,
      credential: parsed.credential,
      // Written checksummed by `writeRecord`; checked for shape here, since checksumming would pull
      // a hash function into every page just to read back what this page wrote.
      owner: parsed.owner,
      session: parsed.session,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      dev: parsed.dev === true,
    };
  } catch {
    return undefined;
  }
}

export function writeRecord(record: AccountRecord): void {
  try {
    window.localStorage.setItem(RECORD_KEY, JSON.stringify(record));
  } catch {
    // Storage full or disabled: the account works for this page and is asked for again next time.
  }
}

export function clearRecord(): void {
  try {
    window.localStorage.removeItem(RECORD_KEY);
  } catch {
    // Nothing readable was there.
  }
}

/*//////////////////////////////////////////////////////////////
                        SESSION KEY STORE
//////////////////////////////////////////////////////////////*/

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB is unavailable"));
  });
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        tx.oncomplete = () => db.close();
      }),
  );
}

async function wrappingKey(): Promise<CryptoKey> {
  const existing = await run<CryptoKey | undefined>("readonly", (store) => store.get(WRAP_KEY_ID));
  if (existing !== undefined) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await run("readwrite", (store) => store.put(key, WRAP_KEY_ID));
  return key;
}

interface SealedKey {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

/** Encrypts and stores the session key for `owner`. The bytes are zeroed afterwards. */
export async function storeSessionKey(owner: Address, privateKey: Uint8Array): Promise<void> {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new Uint8Array(privateKey);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wrappingKey(), plain);
    plain.fill(0);
    const sealed: SealedKey = { iv, ciphertext };
    await run("readwrite", (store) => store.put(sealed, `session:${owner}`));
  } finally {
    privateKey.fill(0);
  }
}

/** The session key for `owner`, decrypted into a buffer the caller zeroes, or `undefined`. */
export async function loadSessionKey(owner: Address): Promise<Uint8Array | undefined> {
  try {
    const sealed = await run<SealedKey | undefined>("readonly", (store) => store.get(`session:${owner}`));
    if (sealed === undefined) return undefined;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, await wrappingKey(), sealed.ciphertext);
    return new Uint8Array(plain);
  } catch {
    return undefined;
  }
}

export async function clearSessionKey(owner: Address): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(`session:${owner}`));
  } catch {
    // Nothing to clear.
  }
}

/*//////////////////////////////////////////////////////////////
                          NOTES KEYS
//////////////////////////////////////////////////////////////*/

/**
 * The keys for a payer's private notes on one network: the AES-GCM key, non-extractable like the
 * wrapping key, and the locker that names the sealed copy to the API. Both come from the passkey's
 * notes namespace, so losing them costs one passkey prompt.
 */
export interface NotesKeys {
  key: CryptoKey;
  locker: string;
}

const notesId = (owner: Address, chainId: number) => `notes:${owner}:${chainId}`;

export async function storeNotesKeys(owner: Address, chainId: number, keys: NotesKeys): Promise<void> {
  try {
    await run("readwrite", (store) => store.put(keys, notesId(owner, chainId)));
  } catch {
    // Not kept: this device asks the passkey again next time.
  }
}

export async function loadNotesKeys(owner: Address, chainId: number): Promise<NotesKeys | undefined> {
  try {
    return await run<NotesKeys | undefined>("readonly", (store) => store.get(notesId(owner, chainId)));
  } catch {
    return undefined;
  }
}

/** Forgets the notes keys for `owner` on every network. */
export async function clearNotesKeys(owner: Address): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(IDBKeyRange.bound(`notes:${owner}:`, `notes:${owner}:￿`)));
  } catch {
    // Nothing to clear.
  }
}
