/**
 * Your payments: every mandate this person has given, from every business, in one place.
 *
 * Stopping, pausing and resuming are signed by the session key kept on this device, so they take
 * one tap and no passkey prompt. That is the "click to cancel" promise, enforced by the contract:
 * the business cannot refuse or delay it.
 *
 * Private notes on each payment are sealed with a key from the passkey's notes namespace
 * (`notes/keys.ts`); Weir's API keeps only the sealed copy.
 */

import { rateOver, type ChargeView, type MandateAction, type MandateView, type PayerResponse } from "@weir/shared";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { Link } from "react-router";

import { Alert, Button, LockIcon, PasskeyIcon, Skeleton, StandingBadge } from "../components/ui";
import { api } from "../lib/api";
import { balanceOf } from "../lib/chain";
import { DEPLOYMENT, IS_TESTNET, NETWORK, TOP_UP_AVAILABLE } from "../lib/config";
import { dateAndTime, dateLong, fromNow, money, moneyExact, periodPhrase, shortAddress } from "../lib/format";
import { signAndAct } from "../lib/mandate";
import { withTransactionToast } from "../lib/toast";
import { nameSupporter } from "../lib/support";
import { NOTE_MAX } from "../notes/keys";
import { usePrivateNotes, type PrivateNotes } from "../notes/usePrivateNotes";
import { useAccount } from "../passkey/AccountProvider";
import { Reminders } from "../reminders/Reminders";
import { SavingsSection } from "../savings/SavingsSection";
import { AddMoneyButton } from "../topup/AddMoney";

const REFRESH_MS = 8_000;

/** A stagger index for `.rise`, so the page settles in order. */
const at = (i: number) => ({ "--i": i }) as CSSProperties;
const MONTH = 2_592_000n;

/** What a toast says while an action is on its way, and once it has landed. */
const ACTION_WORDS: Record<MandateAction, { pending: string; done: string }> = {
  pause: { pending: "Pausing", done: "Paused" },
  resume: { pending: "Resuming", done: "Resumed" },
  cancel: { pending: "Stopping", done: "Stopped" },
};

export function Payments() {
  const account = useAccount();
  if (account.account === undefined) return <SignInFirst />;
  return <PaymentsFor owner={account.account.owner} />;
}

function SignInFirst() {
  const account = useAccount();
  const [error, setError] = useState<string | undefined>();
  return (
    <div className="page-narrow">
      <div className="card card-pad center-card rise">
        <span className="icon-disc" aria-hidden="true">
          <PasskeyIcon size={22} />
        </span>
        <h1>Your payments</h1>
        <p className="card-sub">Sign in with the passkey you subscribed with to see and stop your payments.</p>
        <Button
          size="lg"
          block
          loading={account.busy}
          onClick={async () => {
            setError(undefined);
            const result = await account.signIn();
            if (!result.ok && !result.cancelled) setError(result.message);
          }}
        >
          Sign in with your passkey
        </Button>
        {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
      </div>
    </div>
  );
}

/**
 * What a confirmed action changed, shown at once. The relay answers only after the transaction's
 * receipt, so the change is final; the index catches up a moment later and the override is dropped
 * as soon as the index says the same thing.
 */
type Override = Pick<MandateView, "standing" | "pausedAt"> & Partial<Pick<MandateView, "status">>;

function overrideFor(action: MandateAction): Override {
  const now = Math.floor(Date.now() / 1000);
  if (action === "cancel") return { standing: "Cancelled", status: "Cancelled", pausedAt: 0 };
  if (action === "pause") return { standing: "Paused", pausedAt: now };
  return { standing: "Active", pausedAt: 0 };
}

function PaymentsFor({ owner }: { owner: `0x${string}` }) {
  const account = useAccount();
  const notes = usePrivateNotes(owner);
  const [data, setData] = useState<PayerResponse | undefined>();
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Override>>(new Map());
  const [balance, setBalance] = useState<bigint | undefined>();
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      // Every accepted asset is a six-decimal dollar, so the balance is their sum.
      const [payer, held] = await Promise.all([
        api.payer(owner),
        Promise.all(Object.values(DEPLOYMENT.assets).map((asset) => balanceOf(asset, owner)))
          .then((balances) => balances.reduce((sum, value) => sum + value, 0n))
          .catch(() => undefined),
      ]);
      setData(payer);
      setBalance(held);
      setError(undefined);
      // Drop every override the index now agrees with.
      setOverrides((current) => {
        const next = new Map(current);
        for (const mandate of payer.mandates) {
          if (next.get(mandate.id)?.standing === mandate.standing) next.delete(mandate.id);
        }
        return next.size === current.size ? current : next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [owner]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const mandates = useMemo(
    () => (data?.mandates ?? []).map((m) => ({ ...m, ...overrides.get(m.id) })),
    [data, overrides],
  );
  const live = useMemo(
    () => mandates.filter((m) => m.standing === "Active" || m.standing === "Paused" || m.standing === "Past due"),
    [mandates],
  );
  const ended = useMemo(() => mandates.filter((m) => !live.includes(m)), [mandates, live]);

  const applied = useCallback(
    (id: string, action: MandateAction) => {
      setOverrides((current) => new Map(current).set(id, overrideFor(action)));
      void refresh();
    },
    [refresh],
  );

  const monthly = useMemo(
    () =>
      live
        .filter((m) => m.period > 0 && m.standing !== "Paused")
        .reduce((sum, m) => sum + (BigInt(m.amount) * MONTH) / BigInt(m.period), 0n),
    [live],
  );

  return (
    <div className="container page">
      <div className="page-head rise">
        <div>
          <span className="eyebrow">Signed in with your passkey</span>
          <h1>Your payments</h1>
          <p>
            <span className="address-chip">{shortAddress(owner)}</span>
          </p>
        </div>
        <div className="page-actions">
          {TOP_UP_AVAILABLE ? <AddMoneyButton recipient={owner} size="sm" onClosed={() => void refresh()} /> : null}
          <Button variant="ghost" size="sm" onClick={() => void account.forget()}>
            Sign out on this device
          </Button>
        </div>
      </div>

      <div className="stats rise" style={at(1)}>
        <div className="card stat">
          <div className="stat-label">Active</div>
          <div className="stat-value num">{data === undefined ? <Skeleton width={40} height={28} /> : live.length}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Committed each month</div>
          <div className="stat-value num">{data === undefined ? <Skeleton width={90} height={28} /> : money(monthly)}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Balance</div>
          <div className="stat-value num">{balance === undefined ? <Skeleton width={90} height={28} /> : money(balance)}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Paid so far</div>
          <div className="stat-value num">
            {data === undefined ? (
              <Skeleton width={90} height={28} />
            ) : (
              money(data.mandates.reduce((sum, m) => sum + BigInt(m.totalCharged), 0n))
            )}
          </div>
        </div>
      </div>

      {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}

      <section className="section rise" style={at(2)}>
        <h2 className="section-title">Running</h2>
        {data === undefined ? (
          <div className="card card-pad">
            <Skeleton height={64} />
          </div>
        ) : live.length === 0 ? (
          <div className="card empty">
            <strong>Nothing running</strong>
            When you subscribe to something with Weir, it shows up here, with a button to stop it.
          </div>
        ) : (
          <div className="mandate-list">
            {live.map((mandate) => (
              <MandateCard key={mandate.id} mandate={mandate} notes={notes} onApplied={applied} />
            ))}
          </div>
        )}
      </section>

      {live.length > 0 ? <Reminders payer={owner} /> : null}

      {ended.length > 0 ? (
        <section className="section">
          <h2 className="section-title">Ended</h2>
          <div className="mandate-list">
            {ended.map((mandate) => (
              <MandateCard key={mandate.id} mandate={mandate} notes={notes} onApplied={applied} />
            ))}
          </div>
        </section>
      ) : null}

      <SavingsSection owner={owner} onMoved={() => void refresh()} />

      <section className="section">
        <h2 className="section-title">Activity</h2>
        <Activity charges={data?.charges} mandates={mandates} />
      </section>

      {IS_TESTNET ? (
        <p className="fine-print fine-print-left">
          This is Weir on {NETWORK.label}: the dollars are test dollars. <Link className="link" to="/">About Weir</Link>
        </p>
      ) : null}
    </div>
  );
}

/** What a payment is called, who it pays, and the letter its avatar shows: the payee's. */
function titleOf(mandate: MandateView): { name: string; merchant: string; initial: string } {
  if (mandate.support !== undefined) {
    return { name: `Support for ${mandate.support.name}`, merchant: "Family support", initial: mandate.support.name.slice(0, 1).toUpperCase() };
  }
  const merchant = mandate.plan?.merchantName ?? shortAddress(mandate.merchant);
  return { name: mandate.plan?.name ?? "Payment", merchant, initial: merchant.slice(0, 1).toUpperCase() };
}

function priceOf(mandate: MandateView): string {
  const amount = BigInt(mandate.amount);
  if (mandate.period === 0) return `${money(rateOver(amount, "hour"))} an hour, by the second`;
  // A one-charge payment ("send now") is a single amount, not a schedule.
  if (mandate.maxTotal === mandate.amount) return `${money(amount)}, sent once`;
  return `${money(amount)} every ${periodPhrase(mandate.period)}`;
}

function MandateCard({
  mandate,
  notes,
  onApplied,
}: {
  mandate: MandateView;
  notes: PrivateNotes;
  onApplied: (id: string, action: MandateAction) => void;
}) {
  const account = useAccount();
  const [busy, setBusy] = useState<MandateAction | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [naming, setNaming] = useState<string | undefined>();
  const [named, setNamed] = useState<string | undefined>();
  const [noting, setNoting] = useState<string | undefined>();
  const [unlocking, setUnlocking] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { name, merchant, initial } = titleOf(mandate);
  const note = notes.state.status === "open" ? notes.state.notes[mandate.id] : undefined;
  const support = mandate.support;
  const streaming = mandate.period === 0;
  const running = mandate.standing === "Active" || mandate.standing === "Past due";
  const stoppable = running || mandate.standing === "Paused";

  async function act(action: MandateAction) {
    setError(undefined);
    setBusy(action);
    try {
      const words = ACTION_WORDS[action];
      const result = await withTransactionToast(
        { pending: `${words.pending} ${name}`, success: `${words.done} ${name}`, failure: `Could not ${action === "cancel" ? "stop" : action} ${name}` },
        () => account.withSession((signer) => signAndAct(signer, mandate.id, action)),
        (transaction) => transaction,
      );
      if (result.ok) onApplied(mandate.id, action);
      else if (!result.cancelled) setError(result.message);
      setConfirming(false);
    } finally {
      setBusy(undefined);
    }
  }

  /** Sets the name the person supported sees, signed by the session key: no prompt. */
  async function saveName(event: FormEvent) {
    event.preventDefault();
    if (support === undefined || naming === undefined || naming.trim() === "") return;
    setError(undefined);
    const text = naming.trim();
    const result = await account.withSession((session) =>
      nameSupporter(session, DEPLOYMENT.contracts.MandateHub, support.id, mandate.id, text),
    );
    if (result.ok) {
      setNamed(text);
      setNaming(undefined);
    } else if (!result.cancelled) setError(result.message);
  }

  /** Opens the note editor, unlocking the notes first with one passkey prompt if this device has no key. */
  async function editNote() {
    setError(undefined);
    if (notes.state.status === "open") {
      setNoting(note ?? "");
      return;
    }
    setUnlocking(true);
    try {
      const result = await notes.unlock();
      if (result.ok) setNoting(result.value[mandate.id] ?? "");
      else if (!result.cancelled) setError(result.message);
    } finally {
      setUnlocking(false);
    }
  }

  async function saveNote(event: FormEvent) {
    event.preventDefault();
    if (noting === undefined) return;
    setError(undefined);
    setSavingNote(true);
    try {
      const result = await notes.save(mandate.id, noting);
      if (result.ok) setNoting(undefined);
      else if (!result.cancelled) setError(result.message);
    } finally {
      setSavingNote(false);
    }
  }

  const used = BigInt(mandate.totalCharged);
  const cap = BigInt(mandate.maxTotal);
  const usedShare = cap === 0n ? 0 : Number((used * 1000n) / cap) / 10;

  return (
    <article className="card mandate" data-ended={!stoppable}>
      <div className="mandate-main">
        <span className="merchant-avatar lg" aria-hidden="true">
          {initial}
        </span>
        <div className="mandate-title">
          <h3>{name}</h3>
          <p className="muted">
            {merchant} · {priceOf(mandate)}
          </p>
        </div>
        <StandingBadge standing={mandate.standing} />
      </div>

      <div className="mandate-facts">
        <div>
          <span className="fact-label">{streaming ? "Billing" : "Next charge"}</span>
          <span className="fact-value">
            {mandate.standing === "Paused"
              ? "Paused, nothing is billed"
              : !stoppable
                ? "No more charges"
                : streaming
                  ? "Running now"
                  : `${dateLong(mandate.nextChargeAt)}, ${fromNow(mandate.nextChargeAt)}`}
          </span>
        </div>
        <div>
          <span className="fact-label">Paid so far</span>
          <span className="fact-value num">
            {streaming ? moneyExact(used) : money(used)} of {money(cap)}
          </span>
          <span className="meter" aria-hidden="true">
            <span style={{ width: `${Math.min(100, usedShare)}%` }} />
          </span>
        </div>
        <div>
          <span className="fact-label">Ends</span>
          <span className="fact-value">{dateLong(mandate.expiresAt)}</span>
        </div>
      </div>

      {mandate.vault !== "0x0000000000000000000000000000000000000000" ? (
        <p className="mandate-note">Paid from savings, so the money earns until each charge. Your balance covers any charge savings cannot.</p>
      ) : null}

      {note !== undefined && noting === undefined ? (
        <p className="private-note">
          <LockIcon size={14} />
          <span>{note}</span>
        </p>
      ) : null}

      {stoppable ? (
        confirming ? (
          <div className="confirm-row">
            <span>
              {support === undefined
                ? `Stop this payment? ${merchant} won't be able to charge you again.`
                : `Stop supporting ${support.name}? Nothing more will be sent.`}
            </span>
            <div className="confirm-actions">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy !== undefined}>
                Keep it
              </Button>
              <Button variant="danger" size="sm" onClick={() => void act("cancel")} loading={busy === "cancel"}>
                Stop payment
              </Button>
            </div>
          </div>
        ) : (
          <div className="mandate-actions">
            {streaming && mandate.standing === "Paused" ? (
              <Button size="sm" onClick={() => void act("resume")} loading={busy === "resume"}>
                Resume
              </Button>
            ) : null}
            {streaming && running ? (
              <Button variant="secondary" size="sm" onClick={() => void act("pause")} loading={busy === "pause"}>
                Pause
              </Button>
            ) : null}
            {support !== undefined && running ? (
              <Button variant="ghost" size="sm" onClick={() => setNaming(named ?? "")} disabled={naming !== undefined}>
                Your name for {support.name}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => void editNote()} loading={unlocking} disabled={noting !== undefined || notes.busy}>
              {note === undefined ? "Private note" : "Edit note"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} disabled={busy !== undefined}>
              Stop
            </Button>
          </div>
        )
      ) : null}

      {support !== undefined && naming !== undefined ? (
        <form className="name-row" onSubmit={(event) => void saveName(event)}>
          <input
            className="input"
            value={naming}
            onChange={(event) => setNaming(event.target.value)}
            placeholder={`What ${support.name} sees, like "Ali, London"`}
            maxLength={40}
            autoFocus
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => setNaming(undefined)}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={naming.trim() === ""}>
            Save
          </Button>
        </form>
      ) : null}
      {named !== undefined && naming === undefined ? (
        <p className="mandate-note">
          {support?.name} sees you as {named}.
        </p>
      ) : null}

      {noting !== undefined ? (
        <form className="note-editor" onSubmit={(event) => void saveNote(event)}>
          <div className="name-row">
            <input
              className="input"
              value={noting}
              onChange={(event) => setNoting(event.target.value)}
              placeholder="Only you can read this"
              maxLength={NOTE_MAX}
              aria-label={`Private note for ${name}`}
              autoFocus
            />
            <Button type="button" variant="ghost" size="sm" onClick={() => setNoting(undefined)} disabled={savingNote}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={savingNote}>
              Save
            </Button>
          </div>
          <p className="note-hint">
            <LockIcon size={13} />
            Sealed on this device with a key from your passkey. Weir keeps only the sealed copy.
          </p>
        </form>
      ) : null}

      {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
    </article>
  );
}

const FAILURE: Record<number, string> = {
  1: "balance too low",
  2: "not authorized for that much",
  3: "the payment could not complete",
};

function Activity({ charges, mandates }: { charges: ChargeView[] | undefined; mandates: MandateView[] }) {
  if (charges === undefined) {
    return (
      <div className="card card-pad">
        <Skeleton height={48} />
      </div>
    );
  }
  if (charges.length === 0) {
    return (
      <div className="card empty">
        <strong>No charges yet</strong>
        Every charge appears here the moment it happens.
      </div>
    );
  }
  const byId = new Map(mandates.map((m) => [m.id, m]));
  const explorer = NETWORK.chain.blockExplorers?.default.url;
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>For</th>
            <th>What happened</th>
            <th className="right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {charges.map((charge) => {
            const mandate = byId.get(charge.mandateId);
            const title = mandate === undefined ? `Payment ${charge.mandateId}` : titleOf(mandate).name;
            return (
              <tr key={`${charge.transaction}-${charge.mandateId}-${charge.kind}`}>
                <td className="muted">{dateAndTime(charge.timestamp)}</td>
                <td>{title}</td>
                <td>
                  {charge.kind === "charged" ? (
                    <a className="link" href={`${explorer}/tx/${charge.transaction}`} target="_blank" rel="noreferrer">
                      Paid
                    </a>
                  ) : (
                    <span className="badge badge-negative">Missed: {FAILURE[charge.reason ?? 0] ?? "failed"}</span>
                  )}
                </td>
                <td className="right num">{moneyExact(charge.amount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
