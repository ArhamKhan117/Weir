/**
 * Sending one Web Push message, as a port: the worker and the tests see only this function.
 */

import type { PushSubscriptionRecord } from "../db/store.js";

/** "sent", "gone" when the push service says the browser unsubscribed, or "failed". */
export type PushOutcome = "sent" | "gone" | "failed";

export type PushSender = (subscription: PushSubscriptionRecord, payload: string) => Promise<PushOutcome>;
