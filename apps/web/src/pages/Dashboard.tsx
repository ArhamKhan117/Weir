/**
 * Weir for businesses: create a plan, share its checkout link, watch customers and charges come in.
 *
 * Everything a business sees is read from the index of what happened on chain, so the figures here
 * are the same ones any auditor would compute. Payouts go straight to the business's address with
 * every charge; there is no balance held by Weir to withdraw.
 */

import {
  formatDollarsExact,
  parseDollars,
  permitTypedData,
  rateOver,
  type ChargeTrigger,
  type CreatePlanRequest,
  type MerchantAnalytics,
  type MerchantOverview,
  type Plan,
} from "@weir/shared";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { Link } from "react-router";
import { getAddress, isAddress, isAddressEqual, parseAbi, zeroAddress, type Address } from "viem";

import { Alert, Button, Skeleton, StandingBadge } from "../components/ui";
import { api, ApiRequestError } from "../lib/api";
import { balanceOf, client } from "../lib/chain";
import { CHAIN_ID, DEPLOYMENT, IS_TESTNET, NETWORK } from "../lib/config";
import { dateAndTime, dateShort, money, moneyExact, periodPhrase, pricePhrase, shortAddress } from "../lib/format";
import { DayChart } from "../components/DayChart";
import { MerchantAuthProvider, useMerchantAuth } from "../merchant/MerchantAuth";
import { permitDomainFor } from "../lib/permit";
import { toast } from "../lib/toast";

/** A stagger index for `.rise`, so the page settles in order. */
const at = (i: number) => ({ "--i": i }) as CSSProperties;

export function Dashboard() {
  return (
    <MerchantAuthProvider>
      <DashboardGate />
    </MerchantAuthProvider>
  );
}

function DashboardGate() {
  const auth = useMerchantAuth();
  if (!auth.ready) {
    return (
      <div className="page-narrow">
        <div className="card card-pad">
          <Skeleton height={120} />
        </div>
      </div>
    );
  }
  if (auth.mode === "unconfigured") {
    return (
      <div className="page-narrow">
        <div className="card card-pad center-card">
          <h1>Weir for businesses</h1>
          <p className="card-sub">Business sign-in is being set up. Check back shortly.</p>
        </div>
      </div>
    );
  }
  if (!auth.signedIn) return <BusinessSignIn />;
  return <Workspace />;
}

function BusinessSignIn() {
  const auth = useMerchantAuth();
  return (
    <div className="container page">
      <div className="biz-hero">
        <div className="rise">
          <span className="eyebrow">Weir for businesses</span>
          <h1>Get paid every month, or every second, without chasing anyone.</h1>
          <p className="lede">
            Create a plan, share one link, and your customers subscribe with a passkey. Every charge lands straight in your
            account. Failed charges retry on their own the moment a customer tops up.
          </p>
          <div className="hero-actions">
            <Button size="lg" onClick={auth.signIn}>
              {auth.mode === "dev" ? "Continue with a development account" : "Sign in or create an account"}
            </Button>
          </div>
          {auth.mode === "dev" ? (
            <p className="fine-print fine-print-left">
              Development sign-in: a local business account for testing. Production uses Privy.
            </p>
          ) : null}
        </div>
        <ul className="biz-points card rise" style={at(2)}>
          <li>
            <strong>No card fees, no chargebacks.</strong> Customers authorize a capped mandate once; you charge it on schedule.
          </li>
          <li>
            <strong>Paid instantly.</strong> Each charge moves straight from your customer to you, in under a second.
          </li>
          <li>
            <strong>Usage billing that just works.</strong> Bill by the second for streams, sessions and compute.
          </li>
          <li>
            <strong>Webhooks and a live ledger.</strong> Every subscription and charge, as it happens.
          </li>
        </ul>
      </div>
    </div>
  );
}

function Workspace() {
  const auth = useMerchantAuth();
  const [overview, setOverview] = useState<MerchantOverview | undefined>();
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const authorization = await auth.authorization();
      if (authorization === undefined) return;
      setOverview(await api.merchantOverview(authorization));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [auth]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (overview === undefined) {
    return (
      <div className="container page">
        {error !== undefined ? <Alert tone="negative">{error}</Alert> : <Skeleton height={200} />}
      </div>
    );
  }

  if (overview.profile.name.trim() === "") return <Onboarding onDone={refresh} />;

  return (
    <div className="container page">
      <div className="page-head rise">
        <div>
          <span className="eyebrow">Your business</span>
          <h1>{overview.profile.name}</h1>
          <p className="muted">
            {payoutOf(overview) === undefined ? (
              "No payout wallet yet"
            ) : (
              <>
                Payouts to <span className="mono">{shortAddress(overview.profile.payoutAddress)}</span>
              </>
            )}
            {IS_TESTNET ? " · Testnet" : ""}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void auth.signOut()}>
          Sign out
        </Button>
      </div>

      {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}

      <Stats overview={overview} />
      <Revenue />
      <Plans overview={overview} onChanged={refresh} />
      <Customers overview={overview} />
      <Charges overview={overview} />
      <Earnings overview={overview} />
      <Payouts overview={overview} onChanged={refresh} />
      <Settings overview={overview} onChanged={refresh} />
    </div>
  );
}

/** The payout address a profile holds, or none: the API reports "none" as the zero address. */
function payoutOf(overview: MerchantOverview): Address | undefined {
  const address = overview.profile.payoutAddress;
  return isAddressEqual(address, zeroAddress) ? undefined : address;
}

/**
 * Where charges are paid: one of the wallets linked to this account, which the API insists on
 * too, since a payout to an address the business cannot move from is money lost. `current` stays
 * on the list even when it is no longer linked, so the form shows what is really set.
 */
function PayoutField({
  value,
  current,
  note,
  onChange,
}: {
  value: Address | undefined;
  current?: Address | undefined;
  /** More to say under the field, after the line every payout field carries. */
  note?: string;
  onChange: (address: Address) => void;
}) {
  const auth = useMerchantAuth();
  const options = [...auth.wallets];
  if (current !== undefined && !options.some((wallet) => isAddressEqual(wallet.address, current))) {
    options.push({ address: current, label: "Current" });
  }
  return (
    <div className="field">
      <label className="field-label" htmlFor="payout-wallet">
        Payout wallet
      </label>
      {options.length === 0 ? (
        <p className="muted">No wallet is linked to this account yet.</p>
      ) : (
        <select id="payout-wallet" className="select" value={value ?? ""} onChange={(e) => onChange(getAddress(e.target.value))}>
          {options.map((wallet) => (
            <option key={wallet.address} value={wallet.address}>
              {wallet.label} · {shortAddress(wallet.address)}
            </option>
          ))}
        </select>
      )}
      <span className="field-hint">
        Every charge is paid here directly.{note === undefined ? "" : ` ${note}`}{" "}
        {auth.linkWallet !== undefined ? (
          <button type="button" className="link" onClick={auth.linkWallet}>
            Link another wallet
          </button>
        ) : null}
      </span>
    </div>
  );
}

function Onboarding({ onDone }: { onDone: () => Promise<void> }) {
  const auth = useMerchantAuth();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Address | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Privy creates the embedded wallet just after a first sign-in, so the default can arrive late.
  const payout = chosen ?? auth.wallets[0]?.address;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (payout === undefined) {
      setError("Link a wallet for payouts first.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const authorization = await auth.authorization();
      if (authorization === undefined) return;
      await api.updateMerchant(authorization, { name: name.trim(), payoutAddress: payout });
      await onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-narrow">
      <form className="card card-pad form-card rise" onSubmit={submit}>
        <h1>Set up your business</h1>
        <p className="card-sub">Your customers see this name when they subscribe.</p>
        <label className="field">
          <span className="field-label">Business name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus />
        </label>
        <PayoutField value={payout} onChange={setChosen} />
        {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
        <Button type="submit" size="lg" block loading={busy} disabled={name.trim() === "" || payout === undefined}>
          Continue
        </Button>
      </form>
    </div>
  );
}

function Stats({ overview }: { overview: MerchantOverview }) {
  const sum = (record: Record<string, string>) => Object.values(record).reduce((total, units) => total + BigInt(units), 0n);
  return (
    <div className="stats rise" style={at(1)}>
      <div className="card stat">
        <div className="stat-label">Monthly recurring</div>
        <div className="stat-value num">{money(sum(overview.stats.mrr))}</div>
      </div>
      <div className="card stat">
        <div className="stat-label">Collected, 30 days</div>
        <div className="stat-value num">{money(sum(overview.stats.collected30d))}</div>
      </div>
      <div className="card stat">
        <div className="stat-label">Active customers</div>
        <div className="stat-value num">{overview.stats.activeMandates}</div>
      </div>
      <div className="card stat">
        <div className="stat-label">Past due</div>
        <div className="stat-value num">{overview.stats.pastDue}</div>
      </div>
    </div>
  );
}

const TRIGGERS: Record<ChargeTrigger, string> = {
  Cre: "Chainlink CRE workflow",
  Keeper: "Weir keeper",
  Direct: "Charged as it was set up",
  Settlement: "Streams settled on pause or stop",
};

/**
 * Thirty days of revenue and what charged it, from the Envio HyperIndex project that indexes the
 * hub and the charger: across every wallet the business is paid to. Hidden where the server has no
 * index to read.
 */
function Revenue() {
  const auth = useMerchantAuth();
  const [analytics, setAnalytics] = useState<MerchantAnalytics | null | undefined>();

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const authorization = await auth.authorization();
        if (authorization === undefined) return;
        const result = await api.merchantAnalytics(authorization);
        if (live) setAnalytics(result);
      } catch (cause) {
        if (live && cause instanceof ApiRequestError && cause.status === 503) setAnalytics(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [auth]);

  if (analytics === null) return null;
  const month = analytics?.days.reduce((sum, d) => sum + BigInt(d.volume), 0n);
  const charged = analytics?.triggers.reduce((sum, t) => sum + t.charges, 0) ?? 0;
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Revenue</h2>
        <span className="source-note">Live from Envio HyperIndex</span>
      </div>
      <div className="card card-pad revenue-card">
        {analytics === undefined || month === undefined ? (
          <Skeleton height={220} />
        ) : (
          <>
            <div className="revenue-head">
              <div>
                <div className="stat-label">Last 30 days</div>
                <div className="revenue-figure num">{money(month)}</div>
              </div>
              <dl className="revenue-facts">
                <div>
                  <dt>All time</dt>
                  <dd className="num">{money(BigInt(analytics.revenue))}</dd>
                </div>
                <div>
                  <dt>Monthly recurring</dt>
                  <dd className="num">{money(BigInt(analytics.mrr))}</dd>
                </div>
                <div>
                  <dt>Customers</dt>
                  <dd className="num">
                    {analytics.activeCustomers} <span className="muted">of {analytics.customers}</span>
                  </dd>
                </div>
              </dl>
            </div>
            <DayChart days={analytics.days} label="Revenue per day, last 30 days" />
            {analytics.triggers.length > 0 ? (
              <ul className="trigger-list" aria-label="What charged your customers">
                {analytics.triggers.map((t) => (
                  <li key={t.trigger}>
                    <span>{TRIGGERS[t.trigger]}</span>
                    <span className="muted num">
                      {t.charges} {t.charges === 1 ? "charge" : "charges"}, {money(BigInt(t.volume))}
                    </span>
                    <span className="trigger-bar" aria-hidden="true">
                      <span style={{ width: `${charged === 0 ? 0 : (t.charges / charged) * 100}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/** "1 month", "3 months". */
function monthsPhrase(months: number): string {
  return `${months} ${months === 1 ? "month" : "months"}`;
}

function checkoutUrl(plan: Plan): string {
  return `${window.location.origin}/c/${plan.id}`;
}

function Plans({ overview, onChanged }: { overview: MerchantOverview; onChanged: () => Promise<void> }) {
  const [creating, setCreating] = useState(overview.plans.length === 0);
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Plans</h2>
        {!creating ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            New plan
          </Button>
        ) : null}
      </div>
      {creating ? (
        <NewPlan
          onCancel={overview.plans.length === 0 ? undefined : () => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await onChanged();
          }}
        />
      ) : null}
      <div className="plan-grid">
        {overview.plans.map((plan) => (
          <PlanCard key={plan.id} plan={plan} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}

function PlanCard({ plan, onChanged }: { plan: Plan; onChanged: () => Promise<void> }) {
  const auth = useMerchantAuth();
  const [copied, setCopied] = useState(false);
  const url = checkoutUrl(plan);

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  async function toggle() {
    const authorization = await auth.authorization();
    if (authorization === undefined) return;
    await api.setPlanActive(authorization, plan.id, !plan.active);
    await onChanged();
  }

  return (
    <article className="card card-pad plan-card" data-active={plan.active}>
      <div className="plan-card-head">
        <div>
          <h3>{plan.name}</h3>
          <p className="muted">{pricePhrase(plan)}</p>
        </div>
        <span className={`badge ${plan.active ? "badge-positive" : ""}`}>{plan.active ? "Live" : "Paused"}</span>
      </div>
      <dl className="kv">
        <div>
          <dt>Customers authorize</dt>
          <dd className="num">up to {money(plan.maxTotal)}</dd>
        </div>
        <div>
          <dt>Term</dt>
          <dd>{monthsPhrase(Math.round(plan.termSeconds / 2_592_000))}</dd>
        </div>
        {plan.trialDays > 0 ? (
          <div>
            <dt>Free trial</dt>
            <dd>{plan.trialDays} days</dd>
          </div>
        ) : null}
      </dl>
      <div className="copy-row">
        <code>{url}</code>
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
      <div className="plan-card-actions">
        <Link className="link" to={`/c/${plan.id}`}>
          Open checkout
        </Link>
        <Button variant="ghost" size="sm" onClick={() => void toggle()}>
          {plan.active ? "Pause plan" : "Make live"}
        </Button>
      </div>
    </article>
  );
}

type Billing = "month" | "week" | "year" | "day" | "second";

const PERIOD_SECONDS: Record<Exclude<Billing, "second">, number> = {
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
  year: 31_536_000,
};

function NewPlan({ onCreated, onCancel }: { onCreated: () => Promise<void>; onCancel?: () => void }) {
  const auth = useMerchantAuth();
  const assets = Object.entries(DEPLOYMENT.assets);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [billing, setBilling] = useState<Billing>("month");
  const [price, setPrice] = useState("9.99");
  const [trialDays, setTrialDays] = useState("0");
  const [termMonths, setTermMonths] = useState("12");
  const [streamLimit, setStreamLimit] = useState("50");
  const [asset, setAsset] = useState(assets.at(-1)?.[1] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const preview = useMemo(() => {
    try {
      const units = parseDollars(price);
      const months = Number(termMonths);
      if (units <= 0n || !Number.isInteger(months) || months < 1) return undefined;
      const termSeconds = months * 2_592_000;
      if (billing === "second") {
        const rate = units / 3_600n;
        if (rate === 0n) return undefined;
        const limit = parseDollars(streamLimit);
        return {
          request: {
            mode: "streaming" as const,
            amount: rate,
            period: 0,
            maxPerCharge: rateOver(rate, "day") < limit ? rateOver(rate, "day") : limit,
            maxTotal: limit,
            termSeconds,
          },
          summary: `${money(rateOver(rate, "hour"))} an hour, billed by the second, up to ${money(limit)} per customer`,
        };
      }
      const period = PERIOD_SECONDS[billing];
      const charges = BigInt(Math.max(1, Math.floor(termSeconds / period)));
      return {
        request: { mode: "periodic" as const, amount: units, period, maxPerCharge: units, maxTotal: units * charges, termSeconds },
        summary: `${money(units)} every ${periodPhrase(period)}; customers authorize up to ${money(units * charges)} over ${monthsPhrase(months)}`,
      };
    } catch {
      return undefined;
    }
  }, [billing, price, streamLimit, termMonths]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (preview === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const authorization = await auth.authorization();
      if (authorization === undefined) return;
      const body: CreatePlanRequest = {
        name: name.trim(),
        description: description.trim(),
        asset: getAddress(asset),
        mode: preview.request.mode,
        amount: preview.request.amount.toString(),
        period: preview.request.period,
        trialDays: billing === "second" ? 0 : Number(trialDays) || 0,
        maxPerCharge: preview.request.maxPerCharge.toString(),
        maxTotal: preview.request.maxTotal.toString(),
        termSeconds: preview.request.termSeconds,
      };
      await api.createPlan(authorization, body);
      await onCreated();
    } catch (cause) {
      setError(cause instanceof ApiRequestError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card card-pad form-card new-plan" onSubmit={submit}>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Plan name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pro" required maxLength={60} />
        </label>
        <label className="field">
          <span className="field-label">Billing</span>
          <select className="select" value={billing} onChange={(e) => setBilling(e.target.value as Billing)}>
            <option value="month">Every month</option>
            <option value="week">Every week</option>
            <option value="year">Every year</option>
            <option value="day">Every day</option>
            <option value="second">By the second (usage)</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span className="field-label">Description</span>
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What customers get"
          maxLength={160}
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-label">{billing === "second" ? "Price per hour" : "Price"}</span>
          <span className="input-affix">
            <span>$</span>
            <input className="input num" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" required />
          </span>
        </label>
        {billing === "second" ? (
          <label className="field">
            <span className="field-label">Spending limit per customer</span>
            <span className="input-affix">
              <span>$</span>
              <input className="input num" value={streamLimit} onChange={(e) => setStreamLimit(e.target.value)} inputMode="decimal" />
            </span>
          </label>
        ) : (
          <label className="field">
            <span className="field-label">Free trial (days)</span>
            <input className="input num" value={trialDays} onChange={(e) => setTrialDays(e.target.value)} inputMode="numeric" />
          </label>
        )}
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Term (months)</span>
          <input className="input num" value={termMonths} onChange={(e) => setTermMonths(e.target.value)} inputMode="numeric" />
          <span className="field-hint">Customers renew after this, with one tap.</span>
        </label>
        <label className="field">
          <span className="field-label">Paid in</span>
          <select className="select" value={asset} onChange={(e) => setAsset(e.target.value)}>
            {assets.map(([symbol, address]) => (
              <option key={address} value={address}>
                {symbol}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Alert tone={preview === undefined ? "caution" : "neutral"}>
        {preview === undefined ? "Enter a price and a term to see the plan." : preview.summary}
      </Alert>
      {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
      <div className="form-actions">
        {onCancel !== undefined ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={busy} disabled={preview === undefined || name.trim() === ""}>
          Create plan
        </Button>
      </div>
    </form>
  );
}

function Customers({ overview }: { overview: MerchantOverview }) {
  return (
    <section className="section">
      <h2 className="section-title">Customers</h2>
      {overview.mandates.length === 0 ? (
        <div className="card empty">
          <strong>No customers yet</strong>
          Share a plan's checkout link. Subscriptions appear here the moment they happen.
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Since</th>
                <th className="right">Paid</th>
              </tr>
            </thead>
            <tbody>
              {overview.mandates.map((mandate) => (
                <tr key={mandate.id}>
                  <td className="mono">{shortAddress(mandate.payer)}</td>
                  <td>{mandate.plan?.name ?? "Direct mandate"}</td>
                  <td>
                    <StandingBadge standing={mandate.standing} />
                  </td>
                  <td className="muted">{dateShort(mandate.createdAt)}</td>
                  <td className="right num">{moneyExact(mandate.totalCharged)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Charges({ overview }: { overview: MerchantOverview }) {
  const explorer = NETWORK.chain.blockExplorers?.default.url;
  if (overview.charges.length === 0) return null;
  return (
    <section className="section">
      <h2 className="section-title">Charges</h2>
      <div className="card table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Customer</th>
              <th>Result</th>
              <th className="right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {overview.charges.map((charge) => (
              <tr key={`${charge.transaction}-${charge.mandateId}-${charge.kind}`}>
                <td className="muted">{dateAndTime(charge.timestamp)}</td>
                <td className="mono">{shortAddress(charge.payer)}</td>
                <td>
                  {charge.kind === "charged" ? (
                    <a className="link" href={`${explorer}/tx/${charge.transaction}`} target="_blank" rel="noreferrer">
                      Paid
                    </a>
                  ) : (
                    <span className="badge badge-negative">Missed, retrying</span>
                  )}
                </td>
                <td className="right num">{moneyExact(charge.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const NONCES_ABI = parseAbi(["function nonces(address owner) view returns (uint256)"]);
const ASSETS = Object.entries(DEPLOYMENT.assets);

/**
 * What the business has been paid, sitting in its own wallet, and a way to send it on: to a bank's
 * deposit address, an exchange or another wallet. The wallet signs a permit for exactly the amount
 * (through Privy), and Weir's relayer moves it and pays the fee, so the business needs no gas.
 */
function Earnings({ overview }: { overview: MerchantOverview }) {
  const auth = useMerchantAuth();
  const assets = ASSETS;
  const [from, setFrom] = useState<Address | undefined>();
  const owner = from ?? payoutOf(overview) ?? auth.wallets[0]?.address;
  const [balances, setBalances] = useState<Record<string, bigint> | undefined>();
  const [asset, setAsset] = useState<Address | undefined>();
  const [amountText, setAmountText] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    if (owner === undefined) return;
    const read = await Promise.all(ASSETS.map(async ([, address]) => [address, await balanceOf(address, owner).catch(() => 0n)] as const));
    setBalances(Object.fromEntries(read));
  }, [owner]);

  useEffect(() => {
    setBalances(undefined);
    void load();
  }, [load]);

  const chosen = asset ?? (balances === undefined ? undefined : (assets.find(([, a]) => (balances[a] ?? 0n) > 0n)?.[1] ?? assets[0]?.[1]));
  const symbol = assets.find(([, a]) => a === chosen)?.[0] ?? "";
  const available = chosen === undefined || balances === undefined ? undefined : (balances[chosen] ?? 0n);
  let amount: bigint | undefined;
  try {
    amount = amountText.trim() === "" ? undefined : parseDollars(amountText);
  } catch {
    amount = undefined;
  }
  const destination = isAddress(to.trim()) ? getAddress(to.trim()) : undefined;
  const valid =
    owner !== undefined &&
    chosen !== undefined &&
    amount !== undefined &&
    amount > 0n &&
    available !== undefined &&
    amount <= available &&
    destination !== undefined &&
    !isAddressEqual(destination, owner);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!valid || owner === undefined || chosen === undefined || amount === undefined || destination === undefined) return;
    if (auth.signTypedData === undefined) {
      setError("This sign-in cannot sign for its wallet. Sign out and in again.");
      return;
    }
    setBusy(true);
    setError(undefined);
    const id = toast.pending(`Sending ${money(amount)} ${symbol}`, { body: "Approve it in your wallet. Weir pays the network fee." });
    try {
      const authorization = await auth.authorization();
      if (authorization === undefined) throw new Error("Sign in again to send.");
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const [{ spender }, domain, nonce] = await Promise.all([
        api.payoutInfo(authorization),
        permitDomainFor(chosen),
        client.readContract({ address: chosen, abi: NONCES_ABI, functionName: "nonces", args: [owner] }),
      ]);
      const signature = await auth.signTypedData(
        owner,
        permitTypedData({ token: { address: chosen, permit: domain }, chainId: CHAIN_ID, owner, spender, value: amount, nonce, deadline: BigInt(deadline) }),
      );
      const sent = await api.payout(authorization, { owner, asset: chosen, amount: amount.toString(), to: destination, deadline, signature });
      toast.success(`${money(amount)} ${symbol} sent to ${shortAddress(destination)}`, { replace: id, transaction: sent.transaction });
      setAmountText("");
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const refused = /reject|denied|cancel/i.test(message);
      if (refused) toast.dismiss(id);
      else {
        toast.error("The payout did not go through", { replace: id, body: message });
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <h2 className="section-title">Your earnings</h2>
      <form className="card card-pad form-card" onSubmit={send}>
        <div className="earnings-balances">
          {assets.map(([sym, address]) => (
            <div key={address}>
              <div className="stat-label">{sym}</div>
              <div className="stat-value num">{balances === undefined ? <Skeleton width={90} height={26} /> : money(balances[address] ?? 0n)}</div>
            </div>
          ))}
        </div>
        <p className="muted">
          {owner === undefined
            ? "Link a wallet to be paid into."
            : `In ${auth.wallets.find((w) => isAddressEqual(w.address, owner))?.label ?? "your wallet"}, ${shortAddress(owner)}. Send it on whenever you like: Weir pays the fee.`}
        </p>
        {auth.wallets.length > 1 ? (
          <label className="field">
            <span className="field-label">From</span>
            <select className="select" value={owner ?? ""} onChange={(e) => setFrom(getAddress(e.target.value))}>
              {auth.wallets.map((w) => (
                <option key={w.address} value={w.address}>
                  {w.label} · {shortAddress(w.address)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="field-row">
          <label className="field">
            <span className="field-label">Amount</span>
            <span className="input-affix">
              <span>$</span>
              <input className="input num" inputMode="decimal" placeholder="0.00" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
            </span>
            {available !== undefined && available > 0n ? (
              <button type="button" className="link field-hint" onClick={() => setAmountText(formatDollarsExact(available).replace(/[$,]/g, ""))}>
                Send all {money(available)}
              </button>
            ) : null}
          </label>
          {assets.length > 1 ? (
            <label className="field">
              <span className="field-label">In</span>
              <select className="select" value={chosen ?? ""} onChange={(e) => setAsset(getAddress(e.target.value))}>
                {assets.map(([sym, address]) => (
                  <option key={address} value={address}>
                    {sym}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <label className="field">
          <span className="field-label">To</span>
          <input className="input mono" placeholder="0x… a bank's deposit address, an exchange or another wallet" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
          {to.trim() !== "" && destination === undefined ? <span className="field-hint">That is not an address.</span> : null}
        </label>
        {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
        <div className="form-actions">
          <Button type="submit" loading={busy} disabled={!valid || busy}>
            {amount === undefined || amount === 0n ? "Send" : `Send ${money(amount)}`}
          </Button>
        </div>
      </form>
    </section>
  );
}

function Payouts({ overview, onChanged }: { overview: MerchantOverview; onChanged: () => Promise<void> }) {
  const auth = useMerchantAuth();
  const current = payoutOf(overview);
  const [chosen, setChosen] = useState<Address | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const payout = chosen ?? current ?? auth.wallets[0]?.address;
  const changed = payout !== undefined && (current === undefined || !isAddressEqual(payout, current));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (payout === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const authorization = await auth.authorization();
      if (authorization === undefined) return;
      await api.updateMerchant(authorization, { payoutAddress: payout });
      await onChanged();
      setChosen(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <h2 className="section-title">Payouts</h2>
      <form className="card card-pad form-card" onSubmit={save}>
        <PayoutField
          value={payout}
          current={current}
          note="A change applies to customers who subscribe after it: each mandate pays the wallet its customer agreed to."
          onChange={setChosen}
        />
        {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
        <div className="form-actions">
          <Button type="submit" variant="secondary" loading={busy} disabled={!changed}>
            Save
          </Button>
        </div>
      </form>
    </section>
  );
}

function Settings({ overview, onChanged }: { overview: MerchantOverview; onChanged: () => Promise<void> }) {
  const auth = useMerchantAuth();
  const [url, setUrl] = useState(overview.profile.webhookUrl ?? "");
  const [secret, setSecret] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const authorization = await auth.authorization();
      if (authorization === undefined) return;
      const result = await api.updateMerchant(authorization, { webhookUrl: url.trim() === "" ? null : url.trim() });
      setSecret(result.webhookSecret);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <h2 className="section-title">Webhooks</h2>
      <form className="card card-pad form-card" onSubmit={save}>
        <label className="field">
          <span className="field-label">Endpoint</span>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/weir" />
          <span className="field-hint">
            Weir posts mandate.created, charge.succeeded, charge.failed, mandate.cancelled, mandate.paused and mandate.resumed,
            signed with HMAC-SHA256 in the Weir-Signature header.
          </span>
        </label>
        {secret !== undefined ? (
          <Alert tone="positive">
            Signing secret, shown once: <span className="mono">{secret}</span>
          </Alert>
        ) : null}
        {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
        <div className="form-actions">
          <Button type="submit" variant="secondary" loading={busy}>
            Save
          </Button>
        </div>
      </form>
    </section>
  );
}
