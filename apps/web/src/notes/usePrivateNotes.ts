/**
 * A payer's private notes on this network: opened without a prompt when this device kept the notes
 * keys, or with one passkey prompt at the notes salt when it did not.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";

import { api, ApiRequestError } from "../lib/api";
import { CHAIN_ID, DEPLOYMENT } from "../lib/config";
import { useAccount } from "../passkey/AccountProvider";
import { assertPasskey, type Ceremony } from "../passkey/ceremony";
import { loadNotesKeys, storeNotesKeys, type NotesKeys } from "../passkey/storage";
import { notesKeysFromPrfOutput, notesPrfSalt, openNotes, sealNotes, withNote, type Notes } from "./keys";

export type NotesState =
  | { status: "locked" }
  | { status: "opening" }
  | { status: "open"; notes: Notes }
  | { status: "failed"; message: string };

export interface PrivateNotes {
  state: NotesState;
  /** True while the passkey prompt for the notes is open. */
  busy: boolean;
  unlock(): Promise<Ceremony<Notes>>;
  save(mandateId: string, text: string): Promise<Ceremony<Notes>>;
}

async function fetchNotes(keys: NotesKeys): Promise<Notes> {
  try {
    return await openNotes(keys.key, await api.notes(keys.locker));
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 404) return {};
    throw cause;
  }
}

const failure = (cause: unknown) => ({
  ok: false as const,
  cancelled: false,
  message:
    cause instanceof DOMException && cause.name === "OperationError"
      ? "These notes were sealed with a different passkey."
      : cause instanceof Error
        ? cause.message
        : String(cause),
});

export function usePrivateNotes(owner: Address): PrivateNotes {
  const account = useAccount();
  const credential = account.account?.credential;
  const keys = useRef<NotesKeys | undefined>(undefined);
  const [state, setState] = useState<NotesState>({ status: "locked" });
  const [busy, setBusy] = useState(false);

  const open = useCallback(async (found: NotesKeys): Promise<Ceremony<Notes>> => {
    keys.current = found;
    setState({ status: "opening" });
    try {
      const notes = await fetchNotes(found);
      setState({ status: "open", notes });
      return { ok: true, value: notes };
    } catch (cause) {
      const failed = failure(cause);
      setState({ status: "failed", message: failed.message });
      return failed;
    }
  }, []);

  useEffect(() => {
    let live = true;
    keys.current = undefined;
    setState({ status: "locked" });
    void loadNotesKeys(owner, CHAIN_ID).then((found) => {
      if (live && found !== undefined) void open(found);
    });
    return () => {
      live = false;
    };
  }, [owner, open]);

  const unlock = useCallback(async (): Promise<Ceremony<Notes>> => {
    setBusy(true);
    try {
      const result = await assertPasskey(credential, await notesPrfSalt());
      if (!result.ok) return result;
      const derived = await notesKeysFromPrfOutput(result.value.prfOutput, { chainId: CHAIN_ID, hub: DEPLOYMENT.contracts.MandateHub });
      await storeNotesKeys(owner, CHAIN_ID, derived);
      return await open(derived);
    } finally {
      setBusy(false);
    }
  }, [credential, owner, open]);

  const save = useCallback(
    async (mandateId: string, text: string): Promise<Ceremony<Notes>> => {
      const current = keys.current;
      if (current === undefined || state.status !== "open") return { ok: false, cancelled: false, message: "Unlock your notes first." };
      const next = withNote(state.notes, mandateId, text);
      try {
        await api.saveNotes(current.locker, await sealNotes(current.key, next));
        setState({ status: "open", notes: next });
        return { ok: true, value: next };
      } catch (cause) {
        return failure(cause);
      }
    },
    [state],
  );

  return { state, busy, unlock, save };
}
