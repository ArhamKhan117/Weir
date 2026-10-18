/**
 * One pay-per-request approval: what it may spend, what it has spent, and a stop button that
 * needs no prompt. Requests are paid with no transaction each; what they add up to is settled
 * on chain in batches, which the card shows separately.
 */

import type { MeterView } from "@weir/shared";
import { useState } from "react";

import { Alert, Button } from "../components/ui";
import { NETWORK } from "../lib/config";
import { dateAndTime, dateLong, moneyExact, shortAddress } from "../lib/format";
import { meterName, signAndStopMeter } from "../lib/meter";
import { withTransactionToast } from "../lib/toast";
import { useAccount } from "../passkey/AccountProvider";

const share = (part: string, whole: string): number => {
  const total = BigInt(whole);
  return total === 0n ? 0 : Math.min(100, Number((BigInt(part) * 1000n) / total) / 10);
};

export function MeterCard({ meter, onStopped }: { meter: MeterView; onStopped: () => void }) {
  const account = useAccount();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const name = meterName(meter.ref) ?? shortAddress(meter.merchant);
  const open = meter.status !== "Cancelled" && meter.expiresAt > Math.floor(Date.now() / 1000);
  const unsettled = BigInt(meter.accepted) - BigInt(meter.totalCharged);
  const explorer = NETWORK.chain.blockExplorers?.default.url;

  async function stop() {
    setError(undefined);
    setBusy(true);
    try {
      const result = await withTransactionToast(
        { pending: `Stopping ${name}`, success: `Stopped ${name}`, failure: `Could not stop ${name}` },
        () => account.withSession((session) => signAndStopMeter(session, meter.id)),
        (transaction) => transaction,
      );
      if (result.ok) onStopped();
      else if (!result.cancelled) setError(result.message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card mandate meter-card" data-ended={!open}>
      <div className="mandate-main">
        <span className="merchant-avatar lg" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <div className="mandate-title">
          <h3>{name}</h3>
          <p className="muted">
            Pay per request · pays <span className="mono">{shortAddress(meter.merchant)}</span> in {meter.assetSymbol}
          </p>
        </div>
        <span className={`badge ${open ? (meter.status === "Delinquent" ? "badge-negative" : "badge-positive") : ""}`}>
          {!open ? (meter.status === "Cancelled" ? "Stopped" : "Ended") : meter.status === "Delinquent" ? "Needs funds" : "Active"}
        </span>
      </div>

      <div className="mandate-facts">
        <div>
          <span className="fact-label">Today</span>
          <span className="fact-value num">
            {moneyExact(meter.periodUsed)} of {moneyExact(meter.periodCap)}
          </span>
          <span className="meter" aria-hidden="true">
            <span style={{ width: `${share(meter.periodUsed, meter.periodCap)}%` }} />
          </span>
        </div>
        <div>
          <span className="fact-label">Used so far</span>
          <span className="fact-value num">
            {moneyExact(meter.accepted)} of {moneyExact(meter.maxTotal)}
          </span>
          <span className="meter" aria-hidden="true">
            <span style={{ width: `${share(meter.accepted, meter.maxTotal)}%` }} />
          </span>
        </div>
        <div>
          <span className="fact-label">Requests</span>
          <span className="fact-value num">
            {meter.calls.toLocaleString()}
            {meter.lastCallAt === undefined ? "" : ` · last ${dateAndTime(meter.lastCallAt)}`}
          </span>
        </div>
      </div>

      <p className="meter-settled muted">
        {moneyExact(meter.totalCharged)} settled on chain
        {unsettled > 0n ? `, ${moneyExact(unsettled)} on its way in the next batch` : ""}.{" "}
        {open ? `Approved until ${dateLong(meter.expiresAt)}.` : null}{" "}
        {explorer === undefined ? null : (
          <a className="link" href={`${explorer}/tx/${meter.createdTransaction}`} target="_blank" rel="noreferrer">
            Approval
          </a>
        )}
      </p>

      {open ? (
        confirming ? (
          <div className="confirm-row">
            <span>Stop paying {name}? Requests already made are still settled; nothing new is paid.</span>
            <div className="confirm-actions">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                Keep it
              </Button>
              <Button variant="danger" size="sm" onClick={() => void stop()} loading={busy}>
                Stop
              </Button>
            </div>
          </div>
        ) : (
          <div className="mandate-actions">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
              Stop
            </Button>
          </div>
        )
      ) : null}

      {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
    </article>
  );
}
