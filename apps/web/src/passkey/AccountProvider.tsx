/**
 * The payer's account, for the whole app: who they are, and the two ways they sign.
 *
 * - `withOwner(fn)` runs `fn` with the owner key. The owner key comes from a passkey prompt and is
 *   kept in memory for a few minutes at most, so a new payer who just created their passkey can
 *   subscribe without a second prompt. It is ended, and zeroed, afterwards.
 * - `withSession(fn)` runs `fn` with the session key from this device's encrypted store, with no
 *   prompt. When this device has none (a new browser), it falls back to one passkey prompt, which
 *   also restores the session key here.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Address, LocalAccount } from "viem";

import { assertPasskey, createPasskey, type Ceremony } from "./ceremony";
import type { SigningKey } from "./derivation";
import { devKeysEnabled } from "./devkey";
import {
  clearNotesKeys,
  clearRecord,
  clearSessionKey,
  loadSessionKey,
  readRecord,
  storeSessionKey,
  writeRecord,
  type AccountRecord,
} from "./storage";

const OWNER_TTL_MS = 5 * 60 * 1000;

/**
 * Key derivation (BIP-32 and BIP-39 over secp256k1) is most of the crypto a payer page carries, and
 * it only runs once a passkey has answered, so it loads then rather than with the page. The
 * ceremony itself stays loaded: a browser allows a passkey prompt only close to the tap that asked
 * for it, which a download in between could miss.
 */
const derivation = () => import("./derivation");

export interface AccountApi {
  /** The remembered account, or `undefined` when this device knows none. */
  account: AccountRecord | undefined;
  /** True while a passkey prompt is open. */
  busy: boolean;
  create(label: string): Promise<Ceremony<AccountRecord>>;
  signIn(): Promise<Ceremony<AccountRecord>>;
  withOwner<T>(fn: (owner: LocalAccount) => Promise<T>): Promise<Ceremony<T>>;
  withSession<T>(fn: (session: LocalAccount) => Promise<T>): Promise<Ceremony<T>>;
  forget(): Promise<void>;
}

const AccountContext = createContext<AccountApi | undefined>(undefined);

export function AccountProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<AccountRecord | undefined>(() => readRecord());
  const [busy, setBusy] = useState(false);
  const owner = useRef<{ key: SigningKey; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);

  const endOwner = useCallback(() => {
    if (owner.current === undefined) return;
    clearTimeout(owner.current.timer);
    owner.current.key.end();
    owner.current = undefined;
  }, []);

  useEffect(() => endOwner, [endOwner]);

  const adopt = useCallback(
    async (credential: AccountRecord["credential"], prfOutput: Uint8Array): Promise<AccountRecord> => {
      const keys = (await derivation()).keysFromPrfOutput(prfOutput);
      endOwner();
      owner.current = { key: keys.owner, timer: setTimeout(endOwner, OWNER_TTL_MS) };
      await storeSessionKey(keys.owner.address, keys.sessionPrivateKey);
      const record: AccountRecord = {
        version: 1,
        credential,
        owner: keys.owner.address,
        session: keys.sessionAddress,
        createdAt: Math.floor(Date.now() / 1000),
        dev: devKeysEnabled(),
      };
      writeRecord(record);
      setAccount(record);
      return record;
    },
    [endOwner],
  );

  const prompt = useCallback(
    async (
      ceremony: () => ReturnType<typeof createPasskey>,
    ): Promise<Ceremony<AccountRecord>> => {
      setBusy(true);
      try {
        const result = await ceremony();
        if (!result.ok) return result;
        return { ok: true, value: await adopt(result.value.credential, result.value.prfOutput) };
      } finally {
        setBusy(false);
      }
    },
    [adopt],
  );

  const create = useCallback((label: string) => prompt(() => createPasskey(label)), [prompt]);
  const signIn = useCallback(() => prompt(() => assertPasskey(readRecord()?.credential)), [prompt]);

  const withOwner = useCallback(
    async <T,>(fn: (account: LocalAccount) => Promise<T>): Promise<Ceremony<T>> => {
      if (owner.current === undefined) {
        const restored = await signIn();
        if (!restored.ok) return restored;
      }
      const current = owner.current;
      if (current === undefined) return { ok: false, cancelled: false, message: "The passkey gave no key." };
      try {
        return { ok: true, value: await fn(current.key.account) };
      } catch (cause) {
        return { ok: false, cancelled: false, message: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    [signIn],
  );

  const withSession = useCallback(
    async <T,>(fn: (account: LocalAccount) => Promise<T>): Promise<Ceremony<T>> => {
      const record = readRecord();
      let bytes = record === undefined ? undefined : await loadSessionKey(record.owner);
      if (bytes === undefined) {
        const restored = await signIn();
        if (!restored.ok) return restored;
        bytes = await loadSessionKey(restored.value.owner);
        if (bytes === undefined) {
          return { ok: false, cancelled: false, message: "This browser could not keep the session key." };
        }
      }
      const key = (await derivation()).signingKeyFrom(bytes);
      try {
        return { ok: true, value: await fn(key.account) };
      } catch (cause) {
        return { ok: false, cancelled: false, message: cause instanceof Error ? cause.message : String(cause) };
      } finally {
        key.end();
      }
    },
    [signIn],
  );

  const forget = useCallback(async () => {
    endOwner();
    const record = readRecord();
    if (record !== undefined) await Promise.all([clearSessionKey(record.owner), clearNotesKeys(record.owner)]);
    clearRecord();
    setAccount(undefined);
  }, [endOwner]);

  const api = useMemo<AccountApi>(
    () => ({ account, busy, create, signIn, withOwner, withSession, forget }),
    [account, busy, create, signIn, withOwner, withSession, forget],
  );

  return <AccountContext.Provider value={api}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountApi {
  const api = useContext(AccountContext);
  if (api === undefined) throw new Error("useAccount outside AccountProvider");
  return api;
}

export type { Address };
