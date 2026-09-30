/**
 * Reminders on this device: a notification the day before each payment, and when one fails.
 *
 * The browser subscribes with the API's VAPID key, and the subscription is registered for the
 * payer with a signature from the session key, the key that already stops their payments, so
 * turning reminders on needs no passkey prompt. The browser's own permission prompt comes first,
 * straight from the tap, since browsers only show it in answer to one.
 */

import { pushSubscriptionTypedData } from "@weir/shared";
import type { Address, LocalAccount } from "viem";

import { api } from "./api";
import { CHAIN_ID } from "./config";
import { SIGNATURE_WINDOW } from "./mandate";

const WORKER = "/sw.js";

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** This device's subscription, when reminders are on here. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration === undefined ? null : registration.pushManager.getSubscription();
}

/** Asks the browser for permission. Call it first thing in the tap's handler. */
export async function askPermission(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications are blocked for this site. Allow them in your browser's settings, then try again.");
  }
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Subscribes this device and registers it for `payer`, signed by `signer`, their session key. */
export async function enableReminders(signer: LocalAccount, payer: Address): Promise<void> {
  const { publicKey } = await api.pushKey();
  await navigator.serviceWorker.register(WORKER, { scope: "/" });
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const keys = subscription.toJSON().keys;
  if (keys?.p256dh === undefined || keys.auth === undefined) throw new Error("This browser gave no keys for its subscription.");

  const deadline = Math.floor(Date.now() / 1000) + SIGNATURE_WINDOW;
  const signature = await signer.signTypedData(
    pushSubscriptionTypedData({ chainId: CHAIN_ID, payer, endpoint: subscription.endpoint, deadline: BigInt(deadline) }),
  );
  await api.subscribePush({
    payer,
    signer: signer.address,
    subscription: { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
    deadline,
    signature,
  });
}

/** Stops reminders on this device. */
export async function disableReminders(): Promise<void> {
  const subscription = await currentSubscription();
  if (subscription === null) return;
  await api.unsubscribePush({ endpoint: subscription.endpoint }).catch(() => undefined);
  await subscription.unsubscribe();
}
