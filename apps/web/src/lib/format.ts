/**
 * Money and time in the words a person reads. Nothing here mentions a chain, a token contract or a
 * wallet: "$9.99 every month", "Free for 7 days", "Next charge on 25 October".
 */

import { UNIT, formatDollars, formatDollarsExact, rateOver, type Plan } from "@weir/shared";

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
    return hourly >= 10_000n
      ? `${formatDollars(hourly)} an hour, billed by the second`
      : `${formatDollarsExact(amount)} a second`;
  }
  return `${formatDollars(amount)} every ${periodPhrase(plan.period)}`;
}

/** The short price for a button: "$9.99 / month", "$0.36 / hour". */
export function priceShort(plan: Pick<Plan, "mode" | "amount" | "period">): string {
  const amount = BigInt(plan.amount);
  if (plan.mode === "streaming") return `${formatDollars(rateOver(amount, "hour"))} / hour`;
  return `${formatDollars(amount)} / ${periodPhrase(plan.period)}`;
}

export function money(units: bigint | string): string {
  return formatDollars(typeof units === "string" ? BigInt(units) : units);
}

export function moneyExact(units: bigint | string): string {
  return formatDollarsExact(typeof units === "string" ? BigInt(units) : units);
}

export function isWholeDollars(units: bigint): boolean {
  return units % UNIT === 0n;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });
const shortDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dateTime = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export const dateLong = (seconds: number) => dateFormat.format(new Date(seconds * 1000));
export const dateShort = (seconds: number) => shortDate.format(new Date(seconds * 1000));
export const dateAndTime = (seconds: number) => dateTime.format(new Date(seconds * 1000));

/** "in 3 days", "in 4 hours", "now". */
export function fromNow(seconds: number, now = Math.floor(Date.now() / 1000)): string {
  const delta = seconds - now;
  if (delta <= 60) return "now";
  const units: [number, string][] = [
    [DAY, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (delta >= size) {
      const count = Math.round(delta / size);
      return `in ${count} ${name}${count === 1 ? "" : "s"}`;
    }
  }
  return "now";
}

/** "0x12ab…9f3c" for the rare places an address has to be shown. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
