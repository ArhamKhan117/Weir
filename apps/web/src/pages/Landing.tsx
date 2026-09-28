import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router";

import type { NetworkStats } from "@weir/shared";

import { DayChart } from "../components/DayChart";
import { TRY_HREF } from "../components/Layout";
import { Spotlight } from "../components/Spotlight";
import { api } from "../lib/api";
import { CHAIN_ID, DEPLOYMENT, IS_TESTNET, NETWORK } from "../lib/config";
import { money } from "../lib/format";

/** A stagger index for `.rise`, so a block settles in order. */
const at = (i: number) => ({ "--i": i }) as CSSProperties;

const DOORS = [
  {
    to: "/payments",
    eyebrow: "Paying",
    title: "Your payments",
    body: "Every yes you have given, from every business, in one place. Pause or stop any of them in one tap.",
    poster: "/media/calm-a-poster.jpg",
    tint: "rgba(206, 223, 235, 0.25)",
    action: "See your payments",
  },
  {
    to: "/support",
    eyebrow: "Family",
    title: "Family support",
    body: "One link for the whole family. Each person gives what they can, straight to the person they support.",
    poster: "/media/calm-b-poster.jpg",
    tint: "rgba(247, 236, 233, 0.55)",
    action: "Open a support link",
  },
  {
    to: "/dashboard",
    eyebrow: "Businesses",
    title: "Get paid on time",
    body: "Create a plan, share one link, and charges land in your account the day they are due.",
    poster: "/media/calm-c-poster.jpg",
    tint: "rgba(218, 218, 218, 0.2)",
    action: "Accept payments",
  },
] as const;

const PILLARS = [
  { title: "Your face is the key", body: "A passkey signs every yes. No seed phrase, no wallet app.", icon: "passkey" },
  { title: "Three hard limits", body: "Per charge, per period and in total, enforced on chain.", icon: "limits" },
  { title: "Charged when due", body: "Anyone can collect a charge on time. Nobody can collect it early.", icon: "network" },
  { title: "Stopped in one tap", body: "Pause or cancel at once, and nobody can refuse.", icon: "stop" },
] as const;

const MODES = [
  {
    badge: "By the month",
    title: "Subscriptions and memberships",
    body: "A fixed amount every week, month or year, with free trials and a hard cap on the total.",
    figure: "$9.99",
    unit: "every month",
  },
  {
    badge: "By the second",
    title: "Usage that bills itself",
    body: "Streams, lessons, compute and parking, billed for exactly the seconds used. Pause and nothing accrues.",
    figure: "$0.36",
    unit: "an hour, to the second",
  },
  {
    badge: "Every month",
    title: "Support for family abroad",
    body: "Each person gives what they can, straight to the person they support, in digital dollars.",
    figure: "$50.00",
    unit: "every month",
  },
] as const;

export function Landing() {
  const [created, setCreated] = useState<bigint | undefined>();
  useEffect(() => {
    // The chain client loads for this one figure, after the page has drawn.
    import("../lib/chain")
      .then(({ mandatesCreated }) => mandatesCreated())
      .then(setCreated)
      .catch(() => setCreated(undefined));
  }, []);

  const explorer = NETWORK.chain.blockExplorers?.default.url;

  return (
    <>
      <section className="home-hero">
        <div className="home-hero-image img-hero-frame" aria-hidden="true" />
        <Spotlight image="img-hero-glow" />
        <div className="home-hero-shade" aria-hidden="true" />
        <div className="container home-hero-copy">
          <h1 className="display-hero rise" style={at(1)}>
            Say Yes Once
            <br />
            Pay When It&rsquo;s Due
          </h1>
          <div className="home-hero-side rise" style={at(3)}>
            <p>
              Direct debit for digital dollars. Approve a plan with your face or fingerprint, cap what it can ever take, and keep the
              money in your own account until each charge is due.
            </p>
            <div className="home-hero-actions">
              <Link className="btn btn-light btn-lg" to={TRY_HREF}>
                Try a checkout
              </Link>
              <Link className="btn btn-lg home-hero-outline" to="/payments">
                Your payments
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="container home-section">
        <span className="eyebrow rise">Start here</span>
        <h2 className="display home-heading rise" style={at(1)}>
          One yes, three ways to use it
        </h2>
        <div className="doors">
          {DOORS.map((door, i) => (
            <Link key={door.to} to={door.to} className="door rise" style={at(2 + i)}>
              <img className="door-image" src={door.poster} alt="" aria-hidden="true" loading="lazy" decoding="async" />
              <span className="door-tint" style={{ background: door.tint }} aria-hidden="true" />
              <span className="door-copy">
                <span className="door-eyebrow">{door.eyebrow}</span>
                <span className="door-title">{door.title}</span>
                <span className="door-body">{door.body}</span>
                <span className="door-action">
                  {door.action} <Arrow />
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="home-band">
        <div className="container">
          <span className="eyebrow">Built to be checked</span>
          <h2 className="display home-heading">What a mandate actually does</h2>
          <div className="pillars">
            {PILLARS.map((pillar, i) => (
              <div key={pillar.title} className="pillar">
                <div className="pillar-rule">
                  <h3>{pillar.title}</h3>
                  <p>{pillar.body}</p>
                </div>
                <div className="pillar-card">
                  <img src={`/media/icon-${pillar.icon}.webp`} alt="" aria-hidden="true" width={400} height={400} loading="lazy" decoding="async" />
                  <span className="pillar-n">0{i + 1}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="container home-section tile-feature">
        <div className="tile-copy">
          <span className="eyebrow">It takes what&rsquo;s due</span>
          <h2 className="display home-heading">Never a cent more</h2>
          <p className="tile-lede">
            A mandate is a yes with its limits written in: how much a charge can be, how often, and how much in total. Your dollars
            stay in your account until the day each one is due.
          </p>
          <dl className="tile-facts">
            <div>
              <dt className="num">{created === undefined ? "–" : created.toString()}</dt>
              <dd>mandates set up on {IS_TESTNET ? "Monad Testnet" : "Monad Mainnet"}, read from the contract</dd>
            </div>
            <div>
              <dt>&lt;1 s</dt>
              <dd>from yes to confirmed on Monad</dd>
            </div>
            <div>
              <dt>0%</dt>
              <dd>taken by Weir. No owner, no fee, no custody</dd>
            </div>
          </dl>
          <a className="link" href={`${explorer}/address/${DEPLOYMENT.contracts.MandateHub}`} target="_blank" rel="noreferrer">
            Read the contract
          </a>
        </div>
        <div className="tile-stage">
          <div className="tile-image img-tile-water" aria-hidden="true" />
          <Spotlight image="img-tile-flood" radius={200} />
        </div>
      </section>

      <NetworkLive />

      <section className="container home-section">
        <span className="eyebrow">Three kinds of payment</span>
        <h2 className="display home-heading">Whatever runs on a schedule</h2>
        <div className="modes">
          {MODES.map((mode) => (
            <div key={mode.title} className="mode card">
              <span className="badge badge-accent">{mode.badge}</span>
              <h3>{mode.title}</h3>
              <p>{mode.body}</p>
              <div className="mode-figure num">
                {mode.figure} <span>{mode.unit}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="container home-section">
        <div className="weir-gradient biz-band">
          <h2>
            Get paid on schedule.
            <br />
            Chase nobody.
          </h2>
          <p>Create a plan, share one link, and customers subscribe with a passkey. Every charge lands straight in your account.</p>
          <Link className="btn btn-primary btn-lg" to="/dashboard">
            Start accepting payments
          </Link>
        </div>
      </section>
    </>
  );
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h10m-4-4 4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The network, live: what Weir has done on the network the visitor is on, from Envio HyperIndex.
 * Nothing shows until it loads, and nothing at all where the server has no index to read.
 */
function NetworkLive() {
  const [stats, setStats] = useState<NetworkStats | undefined>();
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .stats()
        .then((response) => live && setStats(response.networks.find((n) => n.chainId === CHAIN_ID)))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (stats === undefined) return null;
  const facts = [
    { value: String(stats.mandates), label: "payments set up, all time" },
    { value: money(BigInt(stats.volume)), label: "moved, payer to business" },
    { value: String(stats.charges), label: "charges, none ever over a limit" },
    { value: String(stats.reports), label: "charged by Chainlink CRE reports" },
  ];
  return (
    <section className="container home-section network-live rise">
      <div className="section-head">
        <div>
          <span className="eyebrow">Live on {IS_TESTNET ? "Monad Testnet" : "Monad Mainnet"}</span>
          <h2 className="display home-heading">Every payment, counted</h2>
        </div>
        <span className="source-note">Indexed by Envio HyperIndex</span>
      </div>
      <div className="card card-pad network-live-card">
        <dl className="network-live-facts">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt className="num">{fact.value}</dt>
              <dd>{fact.label}</dd>
            </div>
          ))}
        </dl>
        <div>
          <div className="stat-label network-live-chart-label">Moved each day, last 30 days</div>
          <DayChart days={stats.days} label="Volume per day, last 30 days" />
        </div>
      </div>
    </section>
  );
}
