/**
 * Family support: someone far away, and the family and friends who each send them money on a
 * schedule, straight from their own accounts.
 *
 * The person supported opens a link with their passkey and shares it. Everyone who opens it picks
 * an amount and says yes once, the way a checkout does; each contribution is its own mandate that
 * pays the recipient directly, so nobody holds the money on the way and nobody's payment depends
 * on anyone else's. The recipient sees who gives what, and what arrives can earn in savings until
 * it is spent.
 */

import { LOCAL_CURRENCIES, localCurrency, parseDollars, SUPPORT_PERIODS, type SupportCircle, type SupportResponse } from "@weir/shared";
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";

import { AccountStep, FundsStep, Step, useFunds } from "../checkout/steps";
import { Alert, Button, CheckIcon, Skeleton, StandingBadge } from "../components/ui";
import { api, ApiRequestError } from "../lib/api";
import { DEPLOYMENT, IS_TESTNET, NETWORK } from "../lib/config";
import { dateShort, money } from "../lib/format";
import { formatLocal, rateSource, useRate, type Rate } from "../lib/fx";
import { signAndInstall } from "../lib/mandate";
import { withTransactionToast } from "../lib/toast";
import { nameSupporter, openSupport, periodWord, perYear, termsForOnce, termsForSupport } from "../lib/support";
import { useAccount } from "../passkey/AccountProvider";
import { SavingsSection } from "../savings/SavingsSection";

const REFRESH_MS = 10_000;

/** A stagger index for `.rise`, so the page settles in order. */
const at = (i: number) => ({ "--i": i }) as CSSProperties;

/** Amounts offered with one tap, in dollars, before anyone types. */
const PRESETS: Record<"week" | "month", readonly number[]> = { week: [10, 25, 50, 100], month: [25, 50, 100, 200] };

/** The asset a new circle is paid in unless its recipient picks another: Agora's dollar where there is one. */
function defaultAsset(): Address {
  const entries = Object.entries(DEPLOYMENT.assets);
  const ausd = entries.find(([symbol]) => /AUSD$/i.test(symbol));
  return (ausd ?? entries[0] ?? ["", zeroAddress])[1];
}

function parseAmount(text: string): bigint | undefined {
  try {
    const units = parseDollars(text);
    return units > 0n ? units : undefined;
  } catch {
    return undefined;
  }
}

/*//////////////////////////////////////////////////////////////
                         OPENING A CIRCLE
//////////////////////////////////////////////////////////////*/

export function SupportStart() {
  const account = useAccount();
  const owner = account.account?.owner;
  const navigate = useNavigate();
  const assets = Object.entries(DEPLOYMENT.assets);

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [currency, setCurrency] = useState("");
  const [period, setPeriod] = useState<number>(SUPPORT_PERIODS.month);
  const [goalText, setGoalText] = useState("");
  const [asset, setAsset] = useState<Address>(defaultAsset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [mine, setMine] = useState<SupportCircle[] | undefined>();

  useEffect(() => {
    if (owner === undefined) return;
    api
      .supportFor(owner)
      .then((response) => setMine(response.circles))
      .catch(() => setMine([]));
  }, [owner]);

  async function create(event: FormEvent) {
    event.preventDefault();
    let goal = 0n;
    if (goalText.trim() !== "") {
      const parsed = parseAmount(goalText);
      if (parsed === undefined) {
        setError("The goal should be an amount in dollars, like 200.");
        return;
      }
      goal = parsed;
    }
    setBusy(true);
    setError(undefined);
    const result = await account.withOwner((signer) => openSupport(signer, { name, note, currency, asset, period, goal }));
    setBusy(false);
    if (result.ok) void navigate(`/s/${result.value.id}`);
    else if (!result.cancelled) setError(result.message);
  }

  return (
    <div className="checkout container">
      <section className="checkout-summary rise" aria-label="Family support">
        <span className="eyebrow">Family support</span>
        <h1 className="plan-name">Money home, on time, without anyone having to ask.</h1>
        <p className="plan-desc support-lead">
          Open a support link and send it to your family. Each person chooses what they can give and sets it up once, with a passkey.
          It arrives in your Weir account in digital dollars, straight from theirs, on the day it is due.
        </p>
        <ul className="assurances">
          <li>Nobody holds the money on the way: each contribution goes straight to you.</li>
          <li>Everyone can change or stop theirs in one tap, and you see who gives what.</li>
          <li>What arrives can earn in savings until you spend it.</li>
        </ul>
        <SupportVisual />
        {mine !== undefined && mine.length > 0 ? (
          <div className="support-mine">
            <h2 className="support-mine-title">Your support links</h2>
            <ul>
              {mine.map((circle) => (
                <li key={circle.id}>
                  <Link className="link" to={`/s/${circle.id}`}>
                    Support for {circle.name}
                  </Link>
                  <span className="muted">every {periodWord(circle.period)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="checkout-steps card rise" style={at(2)} aria-label="Open a support link">
        <AccountStep onError={setError} />
        <Step n={2} title="Your support link" locked={owner === undefined} last>
          {owner === undefined ? (
            <p className="step-copy muted">Available once you are signed in.</p>
          ) : (
            <form className="support-form" onSubmit={create}>
              <label className="field">
                <span className="field-label">Who is it for?</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mum" maxLength={60} required />
                <span className="field-hint">What your family calls you. It is the name on the link.</span>
              </label>
              <label className="field">
                <span className="field-label">What is it for?</span>
                <input
                  className="input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Groceries, medicine and the bills"
                  maxLength={280}
                />
              </label>
              <label className="field">
                <span className="field-label">Where do you live?</span>
                <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  <option value="">Don't show a local currency</option>
                  {LOCAL_CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.flag} {c.country} ({c.code})
                    </option>
                  ))}
                </select>
                <span className="field-hint">Your family sees what each payment is worth where you are.</span>
              </label>
              <div className="field-row">
                <label className="field">
                  <span className="field-label">How often</span>
                  <select className="select" value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
                    <option value={SUPPORT_PERIODS.month}>Every month</option>
                    <option value={SUPPORT_PERIODS.week}>Every week</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Goal (optional)</span>
                  <span className="input-affix">
                    <span>$</span>
                    <input
                      className="input num"
                      inputMode="decimal"
                      placeholder="200"
                      value={goalText}
                      onChange={(e) => setGoalText(e.target.value)}
                    />
                  </span>
                </label>
              </div>
              {assets.length > 1 ? (
                <label className="field">
                  <span className="field-label">Paid in</span>
                  <select className="select" value={asset} onChange={(e) => setAsset(e.target.value as Address)}>
                    {assets.map(([symbol, address]) => (
                      <option key={address} value={address}>
                        {symbol}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <Button type="submit" size="lg" block loading={busy} disabled={name.trim() === ""}>
                Create the link
              </Button>
              <p className="fine-print">Your passkey signs it, so nobody else can open a link that pays you.</p>
            </form>
          )}
        </Step>
        {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
      </section>
    </div>
  );
}

/*//////////////////////////////////////////////////////////////
                           A CIRCLE'S PAGE
//////////////////////////////////////////////////////////////*/

type Load = { state: "loading" } | { state: "ready"; support: SupportResponse } | { state: "error"; message: string };

export function SupportPage() {
  const { id = "" } = useParams();
  const account = useAccount();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const refresh = useCallback(async () => {
    try {
      setLoad({ state: "ready", support: await api.support(id) });
    } catch (error) {
      setLoad((current) =>
        current.state === "ready"
          ? current
          : {
              state: "error",
              message:
                error instanceof ApiRequestError && error.status === 404
                  ? "This link does not lead to anyone's support. Ask for a new one."
                  : error instanceof Error
                    ? error.message
                    : String(error),
            },
      );
    }
  }, [id]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (load.state === "loading") return <SupportSkeleton />;
  if (load.state === "error") {
    return (
      <div className="page-narrow">
        <div className="card card-pad center-card">
          <h1>Link unavailable</h1>
          <p className="card-sub">{load.message}</p>
          <Link className="btn btn-secondary" to="/support">
            About family support
          </Link>
        </div>
      </div>
    );
  }
  const owner = account.account?.owner;
  const recipient = owner !== undefined && isAddressEqual(owner, load.support.circle.recipient);
  return recipient ? <RecipientView support={load.support} /> : <GiveView support={load.support} onGiven={() => void refresh()} />;
}

function givingNow(support: SupportResponse) {
  return support.supporters.filter((supporter) => supporter.standing === "Active" || supporter.standing === "Past due");
}

/** "≈ ₨13,900", with where the rate came from on hover; nothing until a rate has loaded. */
function LocalAmount({ units, currency, rate, suffix = "" }: { units: bigint | string; currency: string; rate: Rate | undefined; suffix?: string }) {
  if (rate === undefined) return null;
  return (
    <span className="local-amount" title={rateSource(rate)}>
      ≈ {formatLocal(BigInt(units), currency, rate)}
      {suffix}
    </span>
  );
}

/** "🇵🇰 Pakistan", or nothing for a circle without a local currency. */
function placeOf(circle: SupportCircle): string | undefined {
  const local = localCurrency(circle.currency);
  return local === undefined ? undefined : `${local.flag} ${local.country}`;
}

function SupportSummary({ support }: { support: SupportResponse }) {
  const { circle } = support;
  const rate = useRate(circle.currency);
  const place = placeOf(circle);
  const word = periodWord(circle.period);
  const giving = givingNow(support);
  const committed = BigInt(support.committedPerPeriod);
  const goal = BigInt(circle.goal);
  const share = goal > 0n ? Math.min(100, Number((committed * 1000n) / goal) / 10) : undefined;

  return (
    <section className="checkout-summary rise" aria-label="Who you are supporting">
      <div className="merchant-line">
        <span className="merchant-avatar" aria-hidden="true">
          {circle.name.slice(0, 1).toUpperCase()}
        </span>
        <span>Family support{place === undefined ? "" : ` · ${place}`}</span>
      </div>
      <h1 className="plan-name">Support {circle.name}</h1>
      {circle.note !== "" ? <p className="plan-desc">{circle.note}</p> : null}

      <div className="support-progress">
        <div className="support-figure num">
          <strong>{money(committed)}</strong>
          {goal > 0n ? ` of ${money(goal)}` : ""} a {word}
        </div>
        {committed > 0n ? <LocalAmount units={committed} currency={circle.currency} rate={rate} suffix={` a ${word} for ${circle.name}`} /> : null}
        {share !== undefined ? (
          <div className="progress" role="progressbar" aria-label="Toward the goal" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share)}>
            <span style={{ width: `${share}%` }} />
          </div>
        ) : null}
        <div className="support-caption">
          {giving.length > 0
            ? `From ${giving.length} ${giving.length === 1 ? "person" : "people"}`
            : BigInt(support.received) > 0n
              ? `Nobody gives every ${word} yet`
              : "Nobody yet: you could be the first."}
          {BigInt(support.received) > 0n ? ` · ${money(support.received)} received so far` : ""}
        </div>
      </div>

      {giving.length > 0 ? (
        <ul className="supporter-list" aria-label="Who gives">
          {giving.map((supporter) => (
            <li key={supporter.mandateId}>
              <span className="merchant-avatar sm" aria-hidden="true">
                {(supporter.name ?? "·").slice(0, 1).toUpperCase()}
              </span>
              <span className="supporter-name">{supporter.name ?? "A supporter"}</span>
              <span className="supporter-amount num">
                {money(supporter.amount)} {supporter.once ? "once" : `a ${word}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="assurances">
        <li>
          Your money goes straight to {circle.name}, in {circle.assetSymbol}. Nobody holds it on the way.
        </li>
        <li>Change or stop it any time, in one tap. No emails, no phone calls.</li>
        <li>These limits are enforced by code nobody can change, including us.</li>
      </ul>
      <SupportVisual />
    </section>
  );
}

/** The site's ring of flags, the picture of money sent home. */
function SupportVisual() {
  return (
    <figure className="support-visual">
      <img src="/media/ring.webp" alt="" aria-hidden="true" width={1200} height={938} loading="lazy" decoding="async" />
      <figcaption>Send money home. Every month.</figcaption>
    </figure>
  );
}

function GiveView({ support, onGiven }: { support: SupportResponse; onGiven: () => void }) {
  const { circle } = support;
  const account = useAccount();
  const owner = account.account?.owner;
  const word = periodWord(circle.period);

  const [once, setOnce] = useState(false);
  const [amountText, setAmountText] = useState(String(PRESETS[word][1]));
  const rate = useRate(circle.currency);
  const place = placeOf(circle);
  const [who, setWho] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [giving, setGiving] = useState(false);
  const [done, setDone] = useState<{ amount: bigint; transaction: Hex; once: boolean; charged: boolean } | undefined>();

  const amount = parseAmount(amountText);
  const vault = support.savingsVault?.address;
  const funds = useFunds(owner, circle.asset, vault, amount ?? 0n);

  async function give() {
    const record = account.account;
    if (record === undefined || amount === undefined) return;
    setError(undefined);
    setGiving(true);
    try {
      const options = { manager: record.session, vault: funds.useSavings ? vault : zeroAddress };
      const terms = once ? termsForOnce(circle, amount, options) : termsForSupport(circle, amount, options);
      const labels = once
        ? { pending: `Sending ${money(amount)} to ${circle.name}`, success: `${money(amount)} sent to ${circle.name}`, failure: "The payment did not go through" }
        : { pending: `Setting up your support for ${circle.name}`, success: `Your support for ${circle.name} is set up`, failure: "Your support did not go through" };
      const result = await withTransactionToast(
        labels,
        () => account.withOwner((signer) => signAndInstall(signer, support, terms)),
        (installed) => installed.transaction,
      );
      if (!result.ok) {
        if (!result.cancelled) setError(result.message);
        return;
      }
      // The name is a courtesy: the session key signs it with no prompt, and a failure to set it
      // never undoes the contribution, which is already on chain.
      if (who.trim() !== "") {
        await account.withSession((session) => nameSupporter(session, support.hub, circle.id, result.value.mandateId, who));
      }
      setDone({ amount, transaction: result.value.transaction, once, charged: result.value.charged });
      onGiven();
    } finally {
      setGiving(false);
    }
  }

  if (done !== undefined) return <Thanks circle={circle} {...done} rate={rate} />;

  const ready = owner !== undefined && amount !== undefined;
  return (
    <div className="checkout container">
      <SupportSummary support={support} />

      <section className="checkout-steps card rise" style={at(2)} aria-label="Give">
        <AccountStep onError={setError} />
        <Step n={2} title="Your contribution" done={ready} locked={owner === undefined}>
          {owner === undefined ? (
            <p className="step-copy muted">Available once you are signed in.</p>
          ) : (
            <div className="give">
              <div className="segmented" role="radiogroup" aria-label="How often">
                {[false, true].map((single) => (
                  <button key={String(single)} type="button" role="radio" aria-checked={once === single} onClick={() => setOnce(single)}>
                    {single ? "Just once" : `Every ${word}`}
                  </button>
                ))}
              </div>
              <div className="chips" role="radiogroup" aria-label="Amount">
                {PRESETS[word].map((dollars) => (
                  <button
                    key={dollars}
                    type="button"
                    role="radio"
                    aria-checked={amountText === String(dollars)}
                    className="chip"
                    onClick={() => setAmountText(String(dollars))}
                  >
                    ${dollars}
                  </button>
                ))}
              </div>
              <label className="field">
                <span className="field-label">{once ? "Send" : `Every ${word}`}</span>
                <span className="input-affix">
                  <span>$</span>
                  <input className="input num" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
                </span>
                {amount !== undefined && rate !== undefined ? (
                  <span className="field-hint">
                    <LocalAmount units={amount} currency={circle.currency} rate={rate} suffix={place === undefined ? "" : ` in ${localCurrency(circle.currency)?.country}`} />
                  </span>
                ) : null}
              </label>
              <label className="field">
                <span className="field-label">Your name, for {circle.name}</span>
                <input className="input" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Optional" maxLength={40} />
              </label>
            </div>
          )}
        </Step>
        <FundsStep
          n={3}
          state={funds}
          asset={circle.asset}
          assetSymbol={circle.assetSymbol}
          needed={amount ?? 0n}
          neededFor={once ? "this payment" : "your first contribution"}
          savingsVault={support.savingsVault}
          onError={setError}
        />
        <Step n={4} title="Confirm" locked={!ready || !funds.funded} last>
          <Button size="lg" block onClick={give} loading={giving} disabled={!ready || !funds.funded || account.busy}>
            {amount === undefined ? (once ? "Send" : "Give") : once ? `Send ${money(amount)} now` : `Give ${money(amount)} every ${word}`}
          </Button>
          {once ? (
            <p className="fine-print">It goes straight to {circle.name} and arrives in seconds. One payment, nothing after it.</p>
          ) : (
            <p className="fine-print">
              It goes straight to {circle.name}.
              {amount === undefined ? "" : ` At most ${money(amount * BigInt(perYear(circle.period)))} over a year.`} Stop it any time from
              Your payments.
            </p>
          )}
        </Step>
        {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
      </section>
    </div>
  );
}

function Thanks({
  circle,
  amount,
  transaction,
  once,
  charged,
  rate,
}: {
  circle: SupportCircle;
  amount: bigint;
  transaction: Hex;
  once: boolean;
  charged: boolean;
  rate: Rate | undefined;
}) {
  // The answer replaces the form in place; start it at the top, not where the button was.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  const explorer = NETWORK.chain.blockExplorers?.default.url;
  return (
    <div className="page-narrow">
      <div className="card success rise">
        <div className="success-tile img-tile-water" aria-hidden="true" />
        <span className="success-mark" aria-hidden="true">
          <CheckIcon size={28} />
        </span>
        <h1>{once ? `Sent to ${circle.name}` : `You're supporting ${circle.name}`}</h1>
        <p className="success-copy">
          {once
            ? `${money(amount)} ${charged ? "has arrived with" : "is on its way to"} ${circle.name}${charged ? ", just now." : " and arrives in a moment."}`
            : `${money(amount)} every ${periodWord(circle.period)}, straight to them. The first arrives in a moment.`}
        </p>
        <LocalAmount units={amount} currency={circle.currency} rate={rate} suffix={once ? "" : ` every ${periodWord(circle.period)}`} />
        <div className="step-actions">
          <Link to="/payments" className="btn btn-primary btn-lg btn-block">
            See your payments
          </Link>
          <a className="btn btn-ghost btn-block" href={`${explorer}/tx/${transaction}`} target="_blank" rel="noreferrer">
            View the receipt on {NETWORK.label}
          </a>
        </div>
      </div>
    </div>
  );
}

function RecipientView({ support }: { support: SupportResponse }) {
  const { circle } = support;
  const word = periodWord(circle.period);
  const link = `${window.location.origin}/s/${circle.id}`;
  const [copied, setCopied] = useState(false);
  const giving = givingNow(support);
  const goal = BigInt(circle.goal);
  const rate = useRate(circle.currency);
  const place = placeOf(circle);

  async function copy() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_600);
  }

  return (
    <div className="container page">
      <div className="page-head rise">
        <div>
          <span className="eyebrow">
            Your support link, every {word}
            {place === undefined ? "" : `, ${place}`}
            {IS_TESTNET ? ", on Testnet" : ""}
          </span>
          <h1>Support for {circle.name}</h1>
        </div>
      </div>

      <div className="card card-pad share-card rise" style={at(1)}>
        <div>
          <div className="share-title">Send this link to your family</div>
          <p className="muted">Each person chooses what they can give and sets it up once, with a passkey.</p>
        </div>
        <div className="copy-row">
          <code>{link}</code>
          <Button variant="secondary" size="sm" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      </div>

      <div className="stats rise" style={at(2)}>
        <div className="card stat">
          <div className="stat-label">Coming in each {word}</div>
          <div className="stat-value num">{money(support.committedPerPeriod)}</div>
          <LocalAmount units={support.committedPerPeriod} currency={circle.currency} rate={rate} />
        </div>
        <div className="card stat">
          <div className="stat-label">Goal</div>
          <div className="stat-value num">{goal > 0n ? money(goal) : "None set"}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">People giving</div>
          <div className="stat-value num">{giving.length}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Received so far</div>
          <div className="stat-value num">{money(support.received)}</div>
          <LocalAmount units={support.received} currency={circle.currency} rate={rate} />
        </div>
      </div>

      <section className="section">
        <h2 className="section-title">Who gives</h2>
        {support.supporters.length === 0 ? (
          <div className="card empty">
            <strong>Nobody yet</strong>
            Share the link above. Each contribution shows up here the moment it is set up.
          </div>
        ) : (
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Since</th>
                  <th>Status</th>
                  <th className="right">Amount</th>
                  <th className="right">Given so far</th>
                </tr>
              </thead>
              <tbody>
                {support.supporters.map((supporter) => (
                  <tr key={supporter.mandateId}>
                    <td>{supporter.name ?? "A supporter"}</td>
                    <td className="muted">{dateShort(supporter.since)}</td>
                    <td>
                      <StandingBadge standing={supporter.standing} />
                    </td>
                    <td className="right num">
                      {money(supporter.amount)} <span className="muted">{supporter.once ? "once" : `a ${word}`}</span>
                    </td>
                    <td className="right num">{money(supporter.totalCharged)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <SavingsSection owner={circle.recipient} onMoved={() => undefined} />
    </div>
  );
}

function SupportSkeleton() {
  return (
    <div className="checkout container" aria-busy="true">
      <section className="checkout-summary">
        <Skeleton width={140} height={18} />
        <div className="gap-16" />
        <Skeleton width="70%" height={34} />
        <div className="gap-12" />
        <Skeleton width="50%" height={22} />
        <div className="gap-28" />
        <Skeleton height={110} />
      </section>
      <section className="checkout-steps card card-pad">
        <Skeleton height={140} />
      </section>
    </div>
  );
}
