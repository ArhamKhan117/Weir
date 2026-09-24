/**
 * Push reminders: a note to the payer's own devices the day before a periodic charge, and when a
 * charge fails, so a debit is never a surprise and a short balance is found in time.
 *
 * Each pass finds what is due from the index, claims each reminder in `push_sent` before sending
 * it, and sends it to every browser the payer registered. The claim comes first, so a reminder is
 * sent at most once even with two workers or a crash mid-pass; a browser the push service says is
 * gone is forgotten. Failures older than `failedLookbackSeconds` are never announced, so turning
 * reminders on does not replay history.
 */

import { formatDollars, type MandateView } from "@weir/shared";

import type { Store } from "../db/store.js";
import { messageOf, type Logger } from "../log.js";
import type { PushSender } from "./sender.js";

/** A day: reminders go out when a charge is this close. */
export const UPCOMING_WINDOW_SECONDS = 86_400;
const FAILED_LOOKBACK_SECONDS = 3_600;

export interface ReminderOptions {
  store: Store;
  send: PushSender;
  logger: Logger;
  now?: () => number;
  pollMs?: number;
}

export interface Reminder {
  title: string;
  body: string;
  /** Replaces an earlier notification with the same tag on the device. */
  tag: string;
  /** The page a tap opens. */
  url: string;
}

const COULD_NOT_COMPLETE = "The payment could not complete. It is tried again on its own.";

const FAILURE: Record<number, string> = {
  1: "Your balance is too low. Add money and it is tried again on its own.",
  2: "It is not authorized for that much. Nothing was taken.",
  3: COULD_NOT_COMPLETE,
};

function labelOf(mandate: MandateView): string {
  if (mandate.support !== undefined) return `Support for ${mandate.support.name}`;
  return mandate.plan?.name ?? "A payment";
}

/** "in about 23 hours", "in about an hour": the device knows the time zone, the server does not. */
function inAbout(seconds: number): string {
  const hours = Math.round(seconds / 3_600);
  if (hours <= 1) return "in about an hour";
  return `in about ${hours} hours`;
}

export function upcomingReminder(mandate: MandateView, chargeAt: number, nowSeconds: number): Reminder {
  const label = labelOf(mandate);
  return {
    title: `${label}: ${formatDollars(BigInt(mandate.amount))} ${chargeAt - nowSeconds > 12 * 3_600 ? "tomorrow" : "soon"}`,
    body: `${formatDollars(BigInt(mandate.amount))} will be paid ${inAbout(chargeAt - nowSeconds)}. You can stop it any time before then.`,
    tag: `upcoming-${mandate.id}`,
    url: "/payments",
  };
}

export function failedReminder(mandate: MandateView, reason: number): Reminder {
  return {
    title: `${labelOf(mandate)} could not be paid`,
    body: FAILURE[reason] ?? COULD_NOT_COMPLETE,
    tag: `failed-${mandate.id}`,
    url: "/payments",
  };
}

export class ReminderWorker {
  readonly #options: ReminderOptions;
  readonly #now: () => number;
  #stopping = false;
  #loop: Promise<void> | undefined;
  #wake: (() => void) | undefined;

  constructor(options: ReminderOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private async deliver(payer: `0x${string}`, reminder: Reminder): Promise<number> {
    const { store, send, logger } = this.#options;
    let delivered = 0;
    for (const subscription of await store.pushSubscriptionsFor(payer)) {
      const outcome = await send(subscription, JSON.stringify(reminder)).catch((error: unknown) => {
        logger.warn("push failed", { error: messageOf(error) });
        return "failed" as const;
      });
      if (outcome === "gone") await store.deletePushSubscription(subscription.endpoint);
      if (outcome === "sent") delivered += 1;
    }
    return delivered;
  }

  /** Sends every reminder that is due now, once. Returns how many notifications went out. */
  async runOnce(): Promise<number> {
    const { store } = this.#options;
    const now = this.#now();
    let sent = 0;

    for (const due of await store.upcomingReminders(now, UPCOMING_WINDOW_SECONDS)) {
      if (!(await store.claimReminder(due.mandateId, "upcoming", String(due.chargeAt), now))) continue;
      const [mandate] = await store.mandates({ mandateId: due.mandateId }, now, 1);
      if (mandate !== undefined) sent += await this.deliver(due.payer, upcomingReminder(mandate, due.chargeAt, now));
    }

    for (const failure of await store.failedReminders(now - FAILED_LOOKBACK_SECONDS)) {
      if (!(await store.claimReminder(failure.mandateId, "failed", failure.key, now))) continue;
      const [mandate] = await store.mandates({ mandateId: failure.mandateId }, now, 1);
      if (mandate !== undefined) sent += await this.deliver(failure.payer, failedReminder(mandate, failure.reason));
    }
    return sent;
  }

  start(): void {
    if (this.#loop !== undefined) return;
    this.#stopping = false;
    const pollMs = this.#options.pollMs ?? 30_000;
    this.#loop = (async () => {
      while (!this.#stopping) {
        try {
          await this.runOnce();
        } catch (error) {
          this.#options.logger.error("reminder pass failed", { error: messageOf(error) });
        }
        await Promise.race([new Promise((resolve) => setTimeout(resolve, pollMs)), new Promise<void>((resolve) => (this.#wake = resolve))]);
      }
    })();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#wake?.();
    await this.#loop;
    this.#loop = undefined;
  }
}
