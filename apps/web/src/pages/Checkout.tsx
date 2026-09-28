/**
 * Checkout: a person arrives from a merchant's link and leaves subscribed.
 *
 * Three steps on one screen, each unlocking the next: an account from a passkey, money to pay
 * with, and one tap to say yes. Nothing here says wallet, gas, chain or token. The terms the payer
 * agrees to are spelled out in full before they tap, because the limits are the product.
 */

import { formatDollars, type CheckoutResponse } from "@weir/shared";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router";
import { zeroAddress, type Hex } from "viem";

import { AccountStep, FundsStep, Step, useFunds } from "../checkout/steps";
import { Alert, Button, CheckIcon, Skeleton } from "../components/ui";
import { api, ApiRequestError } from "../lib/api";
import { NETWORK } from "../lib/config";
import { dateLong, money, periodPhrase, pricePhrase, priceShort } from "../lib/format";
import { signAndInstall, termsFor } from "../lib/mandate";
import { withTransactionToast } from "../lib/toast";
import { useAccount } from "../passkey/AccountProvider";

/** A stagger index for `.rise`, so the page settles in order. */
const at = (i: number) => ({ "--i": i }) as CSSProperties;

type Load = { state: "loading" } | { state: "ready"; checkout: CheckoutResponse } | { state: "error"; message: string };

export function Checkout() {
  const { planId = "" } = useParams();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let live = true;
    api
      .checkout(planId)
      .then((checkout) => live && setLoad({ state: "ready", checkout }))
      .catch((error: unknown) => {
        if (!live) return;
        const message =
          error instanceof ApiRequestError && error.status === 404
            ? "This checkout link does not lead to a plan. Ask the business for a new one."
            : error instanceof Error
              ? error.message
              : String(error);
        setLoad({ state: "error", message });
      });
    return () => {
      live = false;
    };
  }, [planId]);

  if (load.state === "loading") return <CheckoutSkeleton />;
  if (load.state === "error") return <Unavailable message={load.message} />;
  if (!load.checkout.plan.active) {
    return (
      <Unavailable
        message={`${load.checkout.plan.merchant.name} has paused ${load.checkout.plan.name} and is not taking new subscribers right now.`}
      />
    );
  }
  return <CheckoutReady checkout={load.checkout} />;
}

function Unavailable({ message }: { message: string }) {
  return (
    <div className="page-narrow">
      <div className="card card-pad center-card">
        <h1>Checkout unavailable</h1>
        <p className="card-sub">{message}</p>
        <Link className="btn btn-secondary" to="/">
          About Weir
        </Link>
      </div>
    </div>
  );
}

function CheckoutReady({ checkout }: { checkout: CheckoutResponse }) {
  const { plan } = checkout;
  const account = useAccount();
  const owner = account.account?.owner;

  const [error, setError] = useState<string | undefined>();
  const [subscribing, setSubscribing] = useState(false);
  const [done, setDone] = useState<{ mandateId: string; transaction: Hex } | undefined>();

  const firstCharge = plan.mode === "periodic" && plan.trialDays === 0 ? BigInt(plan.amount) : 0n;
  const vault = checkout.savingsVault?.address;
  const funds = useFunds(owner, plan.asset, vault, firstCharge);

  async function subscribe() {
    const record = account.account;
    if (record === undefined) return;
    setError(undefined);
    setSubscribing(true);
    try {
      const terms = termsFor(plan, { manager: record.session, vault: funds.useSavings ? vault : zeroAddress });
      const result = await withTransactionToast(
        { pending: `Subscribing to ${plan.name}`, success: `Subscribed to ${plan.name}`, failure: "The subscription did not go through" },
        () => account.withOwner((signer) => signAndInstall(signer, checkout, terms)),
        (installed) => installed.transaction,
      );
      if (result.ok) setDone(result.value);
      else if (!result.cancelled) setError(result.message);
    } finally {
      setSubscribing(false);
    }
  }

  if (done !== undefined) return <Subscribed checkout={checkout} transaction={done.transaction} />;

  return (
    <div className="checkout container">
      <PlanSummary checkout={checkout} />

      <section className="checkout-steps card rise" style={at(2)} aria-label="Subscribe">
        <AccountStep onError={setError} />
        <FundsStep
          state={funds}
          asset={plan.asset}
          assetSymbol={plan.assetSymbol}
          needed={firstCharge}
          neededFor="the first charge"
          savingsVault={checkout.savingsVault}
          onError={setError}
        />

        <Step n={3} title="Confirm" locked={owner === undefined || !funds.funded} last>
          <Button
            size="lg"
            block
            onClick={subscribe}
            loading={subscribing}
            disabled={owner === undefined || !funds.funded || account.busy}
          >
            {plan.mode === "streaming" ? "Start" : "Subscribe"} · {priceShort(plan)}
          </Button>
          <p className="fine-print">
            You can stop it any time from Your payments. Weir can never take more than the limits above.
          </p>
        </Step>

        {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
      </section>
    </div>
  );
}

function PlanSummary({ checkout }: { checkout: CheckoutResponse }) {
  const { plan } = checkout;
  const expiry = Math.floor(Date.now() / 1000) + plan.termSeconds;
  const trialEnd = Math.floor(Date.now() / 1000) + plan.trialDays * 86_400;
  const limits = useMemo(
    () =>
      plan.mode === "streaming"
        ? [
            ["Billed", "Every second it runs"],
            ["At most at once", money(plan.maxPerCharge)],
            ["At most in total", money(plan.maxTotal)],
            ["Ends", dateLong(expiry)],
          ]
        : [
            ["First charge", plan.trialDays > 0 ? dateLong(trialEnd) : "Today"],
            ["Then", `${money(plan.amount)} every ${periodPhrase(plan.period)}`],
            ["At most in total", money(plan.maxTotal)],
            ["Ends", dateLong(expiry)],
          ],
    [plan, expiry, trialEnd],
  );

  return (
    <section className="checkout-summary rise" aria-label="What you are subscribing to">
      <div className="merchant-line">
        <span className="merchant-avatar" aria-hidden="true">
          {plan.merchant.name.slice(0, 1).toUpperCase()}
        </span>
        <span>{plan.merchant.name}</span>
      </div>
      <h1 className="plan-name">{plan.name}</h1>
      {plan.description !== "" ? <p className="plan-desc">{plan.description}</p> : null}
      <div className="plan-price num">{pricePhrase(plan)}</div>
      {plan.trialDays > 0 ? <span className="badge badge-accent">Free for {plan.trialDays} days</span> : null}

      <dl className="kv plan-limits">
        {limits.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd className="num">{value}</dd>
          </div>
        ))}
      </dl>

      <ul className="assurances">
        <li>Your money stays in your account until each charge.</li>
        <li>
          {plan.mode === "streaming" ? "Pause or stop any time, in one tap." : "Stop any time, in one tap."} No emails, no phone calls.
        </li>
        <li>These limits are enforced by code nobody can change, including us.</li>
      </ul>
    </section>
  );
}

function Subscribed({ checkout, transaction }: { checkout: CheckoutResponse; transaction: Hex }) {
  const { plan } = checkout;
  // The answer replaces the form in place; start it at the top, not where the button was.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  const explorer = NETWORK.chain.blockExplorers?.default.url;
  const first =
    plan.mode === "streaming"
      ? "It is running now, billed by the second."
      : plan.trialDays > 0
        ? `Your first charge of ${money(plan.amount)} is on ${dateLong(Math.floor(Date.now() / 1000) + plan.trialDays * 86_400)}.`
        : `Your first charge of ${money(plan.amount)} happens in a moment.`;
  return (
    <div className="page-narrow">
      <div className="card success rise">
        <div className="success-tile img-tile-water" aria-hidden="true" />
        <span className="success-mark" aria-hidden="true">
          <CheckIcon size={28} />
        </span>
        <h1>You're subscribed</h1>
        <p className="success-copy">
          {plan.name} from {plan.merchant.name}, {pricePhrase(plan)}. {first}
        </p>
        <div className="step-actions">
          <Link to="/payments" className="btn btn-primary btn-lg btn-block">
            See your payments
          </Link>
          <a className="btn btn-ghost btn-block" href={`${explorer}/tx/${transaction}`} target="_blank" rel="noreferrer">
            View the receipt on {NETWORK.label}
          </a>
        </div>
        <p className="fine-print">At most {formatDollars(BigInt(plan.maxTotal))} in total, and you can stop it whenever you like.</p>
      </div>
    </div>
  );
}

function CheckoutSkeleton() {
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
