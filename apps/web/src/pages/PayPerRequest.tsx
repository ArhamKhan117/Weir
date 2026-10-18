/**
 * Pay per request: approve an API once, then pay its requests with no prompt and no gas.
 *
 * An API that takes Weir answers an unpaid request with HTTP 402 and a `weir-meter` offer: who is
 * paid, in what, and the price of one request. This page reads that offer, has the payer approve
 * it within limits they choose (one passkey prompt), and then pays requests from the session key
 * on this device. Below are every API this person pays this way, with what each has used and a
 * stop button.
 */

import { formatDollarsExact, parseDollars, type MeterView } from "@weir/shared";
import type { MeterOffer } from "@weir/x402";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";

import { AccountStep, FundsStep, Step, useFunds } from "../checkout/steps";
import { Alert, Button, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { API_URL, DEPLOYMENT, IS_TESTNET, NETWORK } from "../lib/config";
import { dateLong, moneyExact, shortAddress } from "../lib/format";
import { defaultCaps, demoUrl, METER, meterName, meterTermsFor, payingFetch, readOffer, signAndOpenMeter, type Offer } from "../lib/meter";
import { withTransactionToast } from "../lib/toast";
import { MeterCard } from "../meters/MeterCard";
import { useAccount } from "../passkey/AccountProvider";

const REFRESH_MS = 6_000;
const at = (i: number) => ({ "--i": i }) as CSSProperties;
const CURRENCIES = ["PKR", "INR", "NGN", "EUR", "GBP", "JPY", "MXN", "PHP"] as const;

/** An absolute URL for what the field holds, resolving a path against this page. */
function absolute(url: string): string {
  try {
    return new URL(url, window.location.href).toString();
  } catch {
    return url;
  }
}

const isDemo = (url: string): boolean => /\/demo\/fx(\?|$)/.test(url);

function openMeterFor(meters: readonly MeterView[], offer: MeterOffer | undefined): MeterView | undefined {
  if (offer === undefined) return undefined;
  const now = Math.floor(Date.now() / 1000);
  return meters.find(
    (m) => m.status !== "Cancelled" && m.expiresAt > now && m.merchant === offer.payTo && m.asset === offer.asset,
  );
}

export function PayPerRequest() {
  if (METER === undefined) {
    return (
      <div className="page-narrow">
        <div className="card card-pad rise">
          <h1>Pay per request</h1>
          <p className="muted">Pay per request is not available on {NETWORK.label} yet.</p>
        </div>
      </div>
    );
  }
  return <PayPerRequestPage />;
}

function PayPerRequestPage() {
  const account = useAccount();
  const owner = account.account?.owner;
  const [params] = useSearchParams();
  const [url, setUrl] = useState(() => absolute(params.get("url") ?? demoUrl(API_URL)));
  const [offer, setOffer] = useState<Offer | undefined>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [meters, setMeters] = useState<MeterView[] | undefined>();

  const refresh = useCallback(async () => {
    if (owner === undefined) return;
    try {
      setMeters((await api.payer(owner)).meters);
    } catch {
      // The list refreshes again shortly.
    }
  }, [owner]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const check = useCallback(async (target: string) => {
    setError(undefined);
    setChecking(true);
    try {
      setOffer(await readOffer(target));
    } catch (cause) {
      setOffer(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  }, []);

  // The demo's offer, or the one a link brought, is read as soon as the page opens.
  useEffect(() => {
    void check(url);
    // Only on arrival: later checks are the person's.
  }, []);

  const active = useMemo(() => openMeterFor(meters ?? [], offer?.offer), [meters, offer]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void check(absolute(url));
  }

  return (
    <div className="container page">
      <div className="page-head rise">
        <div>
          <span className="eyebrow">Pay per request</span>
          <h1>Pay for APIs by the request</h1>
          <p className="muted ppr-lede">
            Approve an API once, with limits you choose. Every request after that is paid from your balance with no prompt and no
            gas, settled on {NETWORK.label} in batches. Stop it any time.
          </p>
        </div>
      </div>

      <form className="card card-pad ppr-url rise" style={at(1)} onSubmit={submit}>
        <label className="field">
          <span className="field-label">API address</span>
          <div className="ppr-url-row">
            <input
              className="input mono"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              aria-describedby="ppr-url-hint"
            />
            <Button type="submit" variant="secondary" loading={checking}>
              Check price
            </Button>
          </div>
        </label>
        <p id="ppr-url-hint" className="fine-print fine-print-left">
          {isDemo(url)
            ? "This is Weir's demo API: today's dollar rate for a currency, a tenth of a cent a request."
            : "Any API that answers with a Weir pay-per-request offer."}
        </p>
      </form>

      {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}

      {offer === undefined ? (
        checking ? (
          <div className="card card-pad">
            <Skeleton height={120} />
          </div>
        ) : null
      ) : (
        <div className="checkout ppr-checkout">
          <OfferSummary offer={offer} />
          <section className="checkout-steps card rise" style={at(2)} aria-label="Approve this API">
            {active === undefined ? (
              <ApproveSteps offer={offer} onApproved={refresh} />
            ) : (
              <TryIt offer={offer} meter={active} onPaid={refresh} />
            )}
          </section>
        </div>
      )}

      {owner === undefined ? null : (
        <section className="section">
          <h2 className="section-title">Your APIs</h2>
          {meters === undefined ? (
            <div className="card card-pad">
              <Skeleton height={64} />
            </div>
          ) : meters.length === 0 ? (
            <div className="card empty">
              <strong>Nothing approved yet</strong>
              APIs you approve show up here, with what each has used and a button to stop it.
            </div>
          ) : (
            <div className="mandate-list">
              {meters.map((meter) => (
                <MeterCard key={meter.id} meter={meter} onStopped={() => void refresh()} />
              ))}
            </div>
          )}
        </section>
      )}

      <p className="fine-print fine-print-left">
        {IS_TESTNET ? `This is ${NETWORK.label}: the dollars are test dollars. ` : null}
        <Link className="link" to="/payments">
          Your payments
        </Link>
      </p>
    </div>
  );
}

function OfferSummary({ offer }: { offer: Offer }) {
  const { offer: o } = offer;
  const host = (() => {
    try {
      return new URL(offer.url).host;
    } catch {
      return offer.url;
    }
  })();
  const symbol = Object.entries(DEPLOYMENT.assets).find(([, address]) => address === o.asset)?.[0] ?? shortAddress(o.asset);
  return (
    <section className="checkout-summary rise" aria-label="What this API asks for">
      <div className="merchant-line">
        <span className="merchant-avatar" aria-hidden="true">
          {host.slice(0, 1).toUpperCase()}
        </span>
        <span className="mono">{host}</span>
      </div>
      <h1 className="plan-name">{offer.description ?? "A paid API"}</h1>
      <div className="plan-price num">{formatDollarsExact(o.price)} a request</div>
      <dl className="kv plan-limits">
        <div>
          <dt>Paid to</dt>
          <dd className="mono">{shortAddress(o.payTo)}</dd>
        </div>
        <div>
          <dt>Paid in</dt>
          <dd>{symbol}</dd>
        </div>
        <div>
          <dt>Settled</dt>
          <dd>On {NETWORK.label}, in batches</dd>
        </div>
      </dl>
      <ul className="assurances">
        <li>You approve once. Each request after that needs no prompt and no network fee.</li>
        <li>The API can never take more than you signed for, or more than the limits you set.</li>
        <li>Stop it any time, in one tap.</li>
      </ul>
    </section>
  );
}

function ApproveSteps({ offer, onApproved }: { offer: Offer; onApproved: () => Promise<void> }) {
  const account = useAccount();
  const owner = account.account?.owner;
  const caps = useMemo(() => defaultCaps(offer.offer), [offer]);
  const [perDay, setPerDay] = useState(() => formatDollarsExact(caps.perDay).slice(1));
  const [total, setTotal] = useState(() => formatDollarsExact(caps.total).slice(1));
  const [days, setDays] = useState(caps.days);
  const [error, setError] = useState<string | undefined>();
  const [approving, setApproving] = useState(false);
  const funds = useFunds(owner, offer.offer.asset, undefined, offer.offer.price);

  const parsed = useMemo(() => {
    try {
      const day = parseDollars(perDay.replaceAll(",", ""));
      const all = parseDollars(total.replaceAll(",", ""));
      if (day < offer.offer.price) return { error: `The daily limit must cover at least one request, ${formatDollarsExact(offer.offer.price)}.` };
      if (all < day) return { error: "The total limit must be at least the daily limit." };
      if (!Number.isInteger(days) || days < 1 || days > 365) return { error: "Approve it for between 1 and 365 days." };
      return { perDay: day, total: all };
    } catch {
      return { error: "Enter the limits as dollar amounts." };
    }
  }, [perDay, total, days, offer]);

  async function approve() {
    const record = account.account;
    if (record === undefined || parsed.perDay === undefined || parsed.total === undefined) return;
    setError(undefined);
    setApproving(true);
    try {
      const terms = meterTermsFor(offer.offer, { perDay: parsed.perDay, total: parsed.total, days }, record.session, offer.url);
      const name = meterName(terms.ref) ?? "this API";
      const result = await withTransactionToast(
        { pending: `Approving ${name}`, success: `Approved ${name}`, failure: "The approval did not go through" },
        () => account.withOwner((owner) => signAndOpenMeter(owner, terms)),
        (opened) => opened.transaction,
      );
      if (!result.ok) {
        if (!result.cancelled) setError(result.message);
        return;
      }
      // The approval is on chain; the index has it a moment later.
      for (let i = 0; i < 40; i += 1) {
        const indexed = await api.meter(result.value.meterId).catch(() => undefined);
        if (indexed !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await onApproved();
    } finally {
      setApproving(false);
    }
  }

  const ready = owner !== undefined && funds.funded && parsed.error === undefined;
  return (
    <>
      <AccountStep onError={setError} />
      <FundsStep
        state={funds}
        asset={offer.offer.asset}
        assetSymbol={Object.entries(DEPLOYMENT.assets).find(([, a]) => a === offer.offer.asset)?.[0] ?? "dollars"}
        needed={offer.offer.price}
        neededFor="your first request"
        onError={setError}
      />
      <Step n={3} title="Approve" locked={owner === undefined || !funds.funded} last>
        <div className="ppr-caps">
          <label className="field">
            <span className="field-label">At most a day</span>
            <input className="input num" value={perDay} onChange={(event) => setPerDay(event.target.value)} inputMode="decimal" />
          </label>
          <label className="field">
            <span className="field-label">At most in total</span>
            <input className="input num" value={total} onChange={(event) => setTotal(event.target.value)} inputMode="decimal" />
          </label>
          <label className="field">
            <span className="field-label">For (days)</span>
            <input
              className="input num"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            />
          </label>
        </div>
        {parsed.error !== undefined ? <p className="field-error">{parsed.error}</p> : null}
        <Button size="lg" block onClick={approve} loading={approving} disabled={!ready || account.busy}>
          Approve with your passkey
        </Button>
        <p className="fine-print">
          Nothing is paid now. Each request pays {formatDollarsExact(offer.offer.price)}, settled on {NETWORK.label}; the API can never
          take more than these limits, and you can stop it from here or Your payments.
        </p>
      </Step>
      {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
    </>
  );
}

interface Paid {
  at: number;
  status: number;
  body: string;
  total?: bigint;
}

function TryIt({ offer, meter, onPaid }: { offer: Offer; meter: MeterView; onPaid: () => Promise<void> }) {
  const account = useAccount();
  const [currency, setCurrency] = useState<(typeof CURRENCIES)[number]>("PKR");
  const [busy, setBusy] = useState<number | undefined>();
  const [log, setLog] = useState<Paid[]>([]);
  const [error, setError] = useState<string | undefined>();
  const demo = isDemo(offer.url);

  const target = useMemo(() => {
    if (!demo) return offer.url;
    const next = new URL(offer.url);
    next.searchParams.set("to", currency);
    return next.toString();
  }, [offer.url, demo, currency]);

  async function run(times: number) {
    setError(undefined);
    setBusy(times);
    try {
      const result = await account.withSession(async (session) => {
        let total: bigint | undefined;
        const pay = payingFetch(session, (event) => {
          if (event.settlement?.success === true) total = event.total;
        });
        const entries: Paid[] = [];
        for (let i = 0; i < times; i += 1) {
          total = undefined;
          const response = await pay(target);
          const text = await response.text();
          entries.push({ at: Date.now(), status: response.status, body: text, ...(total === undefined ? {} : { total }) });
          if (!response.ok) break;
        }
        return entries;
      });
      if (result.ok) {
        // Newest first. Reversed outside the updater: React may run an updater twice.
        const fresh = [...result.value].reverse();
        setLog((current) => [...fresh, ...current].slice(0, 20));
      }
      else if (!result.cancelled) setError(result.message);
      await onPaid();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }

  const latest = log[0];
  return (
    <>
      <Step n={1} title="Approved" done>
        <p className="step-copy">
          {meterName(meter.ref) ?? "This API"} may take up to {moneyExact(meter.periodCap)} a day and {moneyExact(meter.maxTotal)} in all,
          until {dateLong(meter.expiresAt)}. Used so far: {moneyExact(meter.accepted)} over {meter.calls.toLocaleString()} request
          {meter.calls === 1 ? "" : "s"}.
        </p>
      </Step>
      <Step n={2} title="Make a paid request" last>
        {demo ? (
          <label className="field">
            <span className="field-label">Dollar rate for</span>
            <select className="select" value={currency} onChange={(event) => setCurrency(event.target.value as (typeof CURRENCIES)[number])}>
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="ppr-try-actions">
          <Button size="lg" onClick={() => void run(1)} loading={busy === 1} disabled={busy !== undefined}>
            Pay {formatDollarsExact(offer.offer.price)} and ask
          </Button>
          <Button variant="secondary" size="lg" onClick={() => void run(10)} loading={busy === 10} disabled={busy !== undefined}>
            Ask 10 times
          </Button>
        </div>
        <p className="fine-print">No prompt: your device signs each payment with its own key, within the limits you approved.</p>
        {latest === undefined ? null : (
          <div className="ppr-result" aria-live="polite">
            <div className="ppr-result-head">
              <span className={`badge ${latest.status === 200 ? "badge-positive" : "badge-negative"}`}>{latest.status === 200 ? "Paid" : `HTTP ${latest.status}`}</span>
              {latest.total === undefined ? null : <span className="muted num">running total {formatDollarsExact(latest.total)}</span>}
            </div>
            <pre className="ppr-body mono">{pretty(latest.body)}</pre>
          </div>
        )}
        {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
      </Step>
    </>
  );
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text.slice(0, 2_000);
  }
}
