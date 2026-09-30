/**
 * Toasts: short notices in the corner about something that just happened, above all a transaction.
 *
 * A module-level store rather than a context, so any code (a page, a helper, a retry loop) can
 * raise one without being inside a provider; `Toaster` renders them. A pending toast stays until it
 * is replaced; the others leave on their own.
 */

import { useSyncExternalStore } from "react";
import type { Hex } from "viem";

import type { Ceremony } from "../passkey/ceremony";
import { NETWORK } from "./config";

export type ToastKind = "pending" | "success" | "error";

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly title: string;
  readonly body?: string;
  /** A transaction to link to on the network's explorer. */
  readonly transaction?: Hex;
}

const LINGER_MS: Record<ToastKind, number | undefined> = { pending: undefined, success: 6_000, error: 10_000 };
const MAX_SHOWN = 4;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const listener of listeners) listener();
}

function schedule(toast: Toast): void {
  clearTimeout(timers.get(toast.id));
  timers.delete(toast.id);
  const linger = LINGER_MS[toast.kind];
  if (linger !== undefined) timers.set(toast.id, setTimeout(() => dismiss(toast.id), linger));
}

function put(toast: Toast): number {
  const exists = toasts.some((t) => t.id === toast.id);
  toasts = exists ? toasts.map((t) => (t.id === toast.id ? toast : t)) : [...toasts, toast].slice(-MAX_SHOWN);
  schedule(toast);
  emit();
  return toast.id;
}

export function dismiss(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const before = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts.length !== before) emit();
}

type Options = { body?: string; transaction?: Hex; replace?: number };

function show(kind: ToastKind, title: string, options: Options = {}): number {
  const { replace, ...rest } = options;
  return put({ id: replace ?? nextId++, kind, title, ...rest });
}

export const toast = {
  pending: (title: string, options?: Options) => show("pending", title, options),
  success: (title: string, options?: Options) => show("success", title, options),
  error: (title: string, options?: Options) => show("error", title, options),
  dismiss,
};

/** What is showing now. */
export function currentToasts(): readonly Toast[] {
  return toasts;
}

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
    () => toasts,
  );
}

/** The explorer page for `transaction` on the chosen network. */
export function transactionUrl(transaction: Hex): string | undefined {
  const explorer = NETWORK.chain.blockExplorers?.default.url;
  return explorer === undefined ? undefined : `${explorer}/tx/${transaction}`;
}

/**
 * Runs a passkey ceremony that ends in a transaction, with a toast for each stage: pending while it
 * runs, then confirmed with a link to the transaction, or the reason it failed. A ceremony the
 * person cancelled leaves no toast. The ceremony's own result comes back unchanged, so a page can
 * still show the outcome inline.
 */
export async function withTransactionToast<T>(
  labels: { pending: string; success: string; failure: string },
  run: () => Promise<Ceremony<T>>,
  transactionOf: (value: T) => Hex | undefined,
): Promise<Ceremony<T>> {
  const id = toast.pending(labels.pending, { body: "Confirm with your passkey if asked. Weir pays the network fee." });
  let result: Ceremony<T>;
  try {
    result = await run();
  } catch (cause) {
    toast.error(labels.failure, { body: cause instanceof Error ? cause.message : String(cause), replace: id });
    throw cause;
  }
  if (result.ok) {
    const transaction = transactionOf(result.value);
    toast.success(labels.success, { replace: id, ...(transaction === undefined ? {} : { transaction }) });
  } else if (result.cancelled) {
    dismiss(id);
  } else {
    toast.error(labels.failure, { body: result.message, replace: id });
  }
  return result;
}
