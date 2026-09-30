/**
 * The switch for reminders on this device, on Your payments. Shown only where the browser can
 * take pushes and the server sends them; everywhere else a payer never sees an option that could
 * not work.
 */

import { useEffect, useState } from "react";
import type { Address } from "viem";

import { Alert, Button } from "../components/ui";
import { api } from "../lib/api";
import { askPermission, currentSubscription, disableReminders, enableReminders, pushSupported } from "../lib/push";
import { useAccount } from "../passkey/AccountProvider";

type State = "checking" | "hidden" | "blocked" | "off" | "on";

export function Reminders({ payer }: { payer: Address }) {
  const account = useAccount();
  const [state, setState] = useState<State>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!pushSupported()) {
      setState("hidden");
      return;
    }
    api
      .pushKey()
      .then(() => currentSubscription())
      .then((subscription) => setState(subscription !== null ? "on" : Notification.permission === "denied" ? "blocked" : "off"))
      .catch(() => setState("hidden"));
  }, []);

  if (state === "checking" || state === "hidden") return null;

  async function turnOn() {
    setBusy(true);
    setError(undefined);
    try {
      try {
        await askPermission();
      } catch (cause) {
        // Refused for good: the card says how to allow them, so no error on top of it.
        if (Notification.permission === "denied") {
          setState("blocked");
          return;
        }
        throw cause;
      }
      const result = await account.withSession((session) => enableReminders(session, payer));
      if (result.ok) setState("on");
      else if (!result.cancelled) setError(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(undefined);
    try {
      await disableReminders();
      setState("off");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad reminders">
      <div className="reminders-row">
        <div className="reminders-text">
          <strong>Reminders on this device</strong>
          <span className="muted">
            {state === "blocked"
              ? "Notifications are blocked for this site. Allow them in your browser's site settings to get a note before each payment."
              : "A note the day before each payment, and straight away if one fails."}
          </span>
        </div>
        {state === "blocked" ? null : state === "on" ? (
          <div className="reminders-actions">
            <span className="badge badge-positive">On</span>
            <Button variant="ghost" size="sm" onClick={() => void turnOff()} loading={busy}>
              Turn off
            </Button>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => void turnOn()} loading={busy}>
            Turn on
          </Button>
        )}
      </div>
      {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
    </div>
  );
}
