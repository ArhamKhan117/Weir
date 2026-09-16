/**
 * Money, time and terms in the words a person reads: "$9.99 every month", "at most $119.88 in
 * total", "20 September 2027, in 360 days". The phrasing matches the web app's, so a plan reads the
 * same in the terminal as it does at checkout.
 */

import { formatDollars, formatDollarsExact, rateOver, type Plan } from "@weir/shared";

const DAY = 86_400;

/** "month", "2 weeks", "30 seconds": the period in the largest whole unit. */
export function periodPhrase(seconds: number): string {
  const units: [number, string][] = [
    [31_536_000, "year"],
    [2_592_000, "month"],
    [604_800, "week"],
    [DAY, "day"],
    [3_600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  for (const [size, name] of units) {
    if (seconds % size === 0) {
      const count = seconds / size;
      return count === 1 ? name : `${count} ${name}s`;
    }
  }
  return `${seconds} seconds`;
}

/** "$9.99 every month" or "$0.36 an hour, billed by the second". */
export function pricePhrase(plan: Pick<Plan, "mode" | "amount" | "period">): string {
  const amount = BigInt(plan.amount);
  if (plan.mode === "streaming") {
    const hourly = rateOver(amount, "hour");
    return hourly >= 10_000n ? `${formatDollars(hourly)} an hour, billed by the second` : `${formatDollarsExact(amount)} a second`;
  }
  return `${formatDollars(amount)} every ${periodPhrase(plan.period)}`;
}

/** The price of a mandate as the hub holds it: a zero period is a per-second stream. */
export function mandatePricePhrase(mandate: { amount: bigint | string; period: number }): string {
  return pricePhrase({
    mode: mandate.period === 0 ? "streaming" : "periodic",
    amount: mandate.amount.toString(),
    period: mandate.period,
  });
}

/** Base units as "$1,234.56". */
export function money(units: bigint | string): string {
  return formatDollars(typeof units === "string" ? BigInt(units) : units);
}

/** Base units at full precision, for streams and rates where cents would read as zero. */
export function moneyExact(units: bigint | string): string {
  return formatDollarsExact(typeof units === "string" ? BigInt(units) : units);
}

/** "20 September 2027". `timeZone` is for tests; people get their own. */
export function dateLong(seconds: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", ...(timeZone === undefined ? {} : { timeZone }) }).format(
    new Date(seconds * 1000),
  );
}

/** "25 September 2026, 17:03". */
export function dateTime(seconds: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(seconds * 1000));
}

/** "in 3 days", "in 4 hours", "now", "2 days ago". */
export function fromNow(seconds: number, now: number): string {
  const delta = seconds - now;
  const ahead = delta >= 0;
  const span = Math.abs(delta);
  if (span <= 60) return "now";
  const units: [number, string][] = [
    [DAY, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (span >= size) {
      const count = Math.round(span / size);
      const phrase = `${count} ${name}${count === 1 ? "" : "s"}`;
      return ahead ? `in ${phrase}` : `${phrase} ago`;
    }
  }
  return "now";
}

/** "360 days", "1 year", "12 hours": a length of time in its largest whole unit. */
export function durationPhrase(seconds: number): string {
  const phrase = periodPhrase(seconds);
  return /^\d/.test(phrase) ? phrase : `1 ${phrase}`;
}

/** "0x4e80…aF8C", for lists where the full address would crowd the line. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Basis points as "5.0% a year". */
export function apyPhrase(bps: number): string {
  return `${(bps / 100).toFixed(1)}% a year`;
}
