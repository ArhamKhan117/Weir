/**
 * The {@link PushSender} over Web Push: each reminder is encrypted to the browser's keys and
 * handed to its push service, signed with the server's VAPID key. The library is loaded on first
 * use, so a server without reminders never loads it.
 */

import type { Secret } from "@weir/shared";

import type { PushSender } from "./sender.js";

/** How long a push service may hold a reminder for a browser that is offline: half a day. */
const TTL_SECONDS = 12 * 3_600;

type WebPush = typeof import("web-push");

/** The package is CommonJS: imported from ESM, its API arrives as `default`. */
async function loadWebPush(): Promise<WebPush> {
  const module = (await import("web-push")) as WebPush & { default?: WebPush };
  return module.default ?? module;
}

export function webPushSender(vapid: { publicKey: string; privateKey: Secret; subject: string }): PushSender {
  let library: Promise<WebPush> | undefined;
  return async (subscription, payload) => {
    library ??= loadWebPush();
    const webpush = await library;
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        payload,
        {
          TTL: TTL_SECONDS,
          urgency: "normal",
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey.reveal() },
        },
      );
      return "sent";
    } catch (error) {
      // 404 and 410 are the push service saying this browser unsubscribed: forget it.
      const status = (error as { statusCode?: unknown }).statusCode;
      if (status === 404 || status === 410) return "gone";
      throw error;
    }
  };
}
