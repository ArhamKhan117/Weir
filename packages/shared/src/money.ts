/**
 * Dollars in, base units out, and back. Every asset a mandate charges has six decimals, so one
 * base unit is a millionth of a dollar and a per-second rate can be far below a cent.
 *
 * Parsing is exact: no floating point touches an amount. Formatting rounds only for display and
 * says so in its name.
 */

export const DECIMALS = 6;
export const UNIT = 1_000_000n;

const SECONDS = { hour: 3_600n, day: 86_400n, month: 2_592_000n } as const;

/** "$12.50", "12.5", "0.000278" to base units. Throws on anything that is not a plain amount. */
export function parseDollars(input: string): bigint {
  const text = input.trim().replace(/^\$/, "").replaceAll(",", "");
  const match = /^(\d+)(?:\.(\d{0,6}))?$/.exec(text);
  if (match === null) throw new RangeError(`"${input}" is not a dollar amount with at most six decimals`);
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(DECIMALS, "0"));
  return whole * UNIT + fraction;
}

/** Base units as "$1,234.56", to the cent, rounding half up. */
export function formatDollars(units: bigint): string {
  const negative = units < 0n;
  const cents = ((negative ? -units : units) + 5_000n) / 10_000n;
  const whole = (cents / 100n).toLocaleString("en-US");
  const rest = (cents % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${rest}`;
}

/**
 * Base units at full precision, trailing zeros trimmed but never below cents: "$0.000278",
 * "$4.20". For rates and small streamed amounts, where rounding to the cent would read as zero.
 */
export function formatDollarsExact(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = (abs / UNIT).toLocaleString("en-US");
  let fraction = (abs % UNIT).toString().padStart(DECIMALS, "0");
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${negative ? "-" : ""}$${whole}.${fraction}`;
}

/** The per-second rate, in base units, that bills `units` over `per`. Rounds down. */
export function ratePerSecond(units: bigint, per: keyof typeof SECONDS): bigint {
  return units / SECONDS[per];
}

/** What a per-second rate comes to over a longer span. */
export function rateOver(ratePerSecondUnits: bigint, per: keyof typeof SECONDS): bigint {
  return ratePerSecondUnits * SECONDS[per];
}
