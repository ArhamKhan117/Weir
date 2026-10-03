/**
 * The workflow's configuration: `weir-charger/config.json` for staging (Monad Testnet) and
 * `weir-charger/config.production.json` for production (Monad Mainnet).
 *
 * Validated by hand and exposed as a Standard Schema, which is what the SDK's `Runner` accepts.
 * No schema library is used, because the checks that matter here are not generic: an address
 * must not be zero, a schedule must fire at a steady interval the near-expiry rule can use, and a
 * batch must fit under CRE's gas ceiling. Nothing here may touch `URL`, `process` or any other
 * global the WebAssembly sandbox lacks.
 */

import { GAS_BASE, GAS_CEILING, GAS_PER_MANDATE, maxBatchFor, type DuePolicy, type TickConfig } from "./tick.js";

export interface WorkflowConfig extends TickConfig {
  /** A 6 field (seconds first) or 5 field cron expression. */
  readonly schedule: string;
  /** Seconds between firings, derived from `schedule`. */
  readonly intervalSeconds: number;
  /** The CRE chain selector name: `monad-testnet` or `monad-mainnet`. */
  readonly chainSelectorName: string;
  readonly hub: `0x${string}`;
  readonly charger: `0x${string}`;
  readonly policy: DuePolicy;
}

export const DEFAULTS = {
  schedule: "0 */5 * * * *",
  pageSize: 200,
  maxBatch: 50,
  gasPerMandate: GAS_PER_MANDATE,
  streamMinCharge: 10_000n,
  streamMaxAgeSeconds: 3_600n,
} as const;

/** Ids per page read. Each id is three calls; this keeps one read well inside an `eth_call`. */
export const MAX_PAGE_SIZE = 500;

/** The chain selector names this workflow knows a Monad network by. */
export const CHAIN_SELECTOR_NAMES = ["monad-testnet", "monad-mainnet"] as const;

/** CRE refuses a cron trigger that fires more often than this. */
export const FASTEST_INTERVAL_SECONDS = 30;

export interface ConfigIssue {
  readonly message: string;
  readonly path: readonly string[];
}

export type ConfigResult = { readonly value: WorkflowConfig } | { readonly issues: readonly ConfigIssue[] };

/*//////////////////////////////////////////////////////////////
                             SCHEDULE
//////////////////////////////////////////////////////////////*/

const FIXED = /^[0-9]+$/;
const STEP = /^(?:\*|0)\/([0-9]+)$/;
const ANY = /^[*?]$/;

/**
 * The seconds between firings of a cron expression that fires at a steady interval, or
 * `undefined` for one that does not.
 *
 * Steady means: the finest time field that is not a single value is `*` or a step (`*\/N` or
 * `0/N`) that divides its unit evenly, every finer field is a single value, and every coarser
 * field, day of month, month and day of week included, is `*`. A schedule where every time field
 * is a single value fires once a day. That covers every schedule a keeper should run on: every
 * 30 seconds, every 5 minutes, hourly, daily. Anything else ("weekdays at nine") is refused
 * rather than guessed at, because the near-expiry window depends on it.
 */
export function scheduleIntervalSeconds(schedule: string): number | undefined {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return undefined;
  const [second, minute, hour, ...date] = fields.length === 6 ? fields : ["0", ...fields];
  if (!date.every((field) => ANY.test(field))) return undefined;

  const units = [
    { field: second ?? "", seconds: 1, span: 60 },
    { field: minute ?? "", seconds: 60, span: 60 },
    { field: hour ?? "", seconds: 3_600, span: 24 },
  ];
  for (const [index, unit] of units.entries()) {
    if (FIXED.test(unit.field)) {
      if (Number(unit.field) >= unit.span) return undefined;
      continue;
    }
    const step = ANY.test(unit.field) ? 1 : Number(STEP.exec(unit.field)?.[1] ?? Number.NaN);
    if (!Number.isInteger(step) || step < 1 || unit.span % step !== 0) return undefined;
    if (!units.slice(index + 1).every((coarser) => ANY.test(coarser.field))) return undefined;
    return step * unit.seconds;
  }
  return 86_400;
}

/*//////////////////////////////////////////////////////////////
                               PARSE
//////////////////////////////////////////////////////////////*/

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;
const UNSIGNED = /^[0-9]+$/;

const KNOWN_KEYS = new Set([
  "schedule",
  "chainSelectorName",
  "hub",
  "charger",
  "pageSize",
  "maxBatch",
  "gasPerMandate",
  "streamMinCharge",
  "streamMaxAgeSeconds",
]);

/** Validate a parsed config file and apply the defaults. Collects every issue, not just the first. */
export function parseConfig(input: unknown): ConfigResult {
  const issues: ConfigIssue[] = [];
  const fail = (key: string, message: string): undefined => {
    issues.push({ path: [key], message: `${key} ${message}` });
    return undefined;
  };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { issues: [{ path: [], message: "the config must be a JSON object" }] };
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) fail(key, "is not a setting this workflow reads");

  const address = (key: string): `0x${string}` | undefined => {
    const value = raw[key];
    if (typeof value !== "string" || !ADDRESS.test(value)) return fail(key, "must be a 0x-prefixed 20-byte address");
    if (ZERO_ADDRESS.test(value)) return fail(key, "is the zero address; fill it in from the deployment record");
    return value as `0x${string}`;
  };
  const integer = (key: string, fallback: number, lowest: number, highest: number): number | undefined => {
    const value = raw[key] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < lowest || value > highest) {
      return fail(key, `must be an integer from ${lowest} to ${highest}`);
    }
    return value;
  };
  const amount = (key: string, fallback: bigint): bigint | undefined => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === "string" && UNSIGNED.test(value)) return BigInt(value);
    return fail(key, "must be a non-negative integer, as a number or a decimal string");
  };

  const scheduleValue = raw.schedule ?? DEFAULTS.schedule;
  let schedule: string | undefined;
  let intervalSeconds: number | undefined;
  if (typeof scheduleValue !== "string") {
    fail("schedule", "must be a cron expression");
  } else {
    intervalSeconds = scheduleIntervalSeconds(scheduleValue);
    if (intervalSeconds === undefined) {
      fail("schedule", `"${scheduleValue}" does not fire at a steady interval; use every N seconds, minutes or hours`);
    } else if (intervalSeconds < FASTEST_INTERVAL_SECONDS) {
      fail("schedule", `"${scheduleValue}" fires every ${intervalSeconds}s; CRE's fastest cron is every ${FASTEST_INTERVAL_SECONDS}s`);
    } else {
      schedule = scheduleValue;
    }
  }

  const chainSelectorName = raw.chainSelectorName;
  if (typeof chainSelectorName !== "string" || !(CHAIN_SELECTOR_NAMES as readonly string[]).includes(chainSelectorName)) {
    fail("chainSelectorName", `must be one of ${CHAIN_SELECTOR_NAMES.join(", ")}`);
  }

  const hub = address("hub");
  const charger = address("charger");
  const pageSize = integer("pageSize", DEFAULTS.pageSize, 1, MAX_PAGE_SIZE);
  const gasPerMandate = amount("gasPerMandate", DEFAULTS.gasPerMandate);
  if (gasPerMandate !== undefined && (gasPerMandate < 50_000n || gasPerMandate > GAS_CEILING - GAS_BASE)) {
    fail("gasPerMandate", `must be from 50000 to ${GAS_CEILING - GAS_BASE}`);
  }
  // The batch the gas ceiling can carry depends on the allowance per mandate.
  const maxBatch = integer("maxBatch", DEFAULTS.maxBatch, 1, maxBatchFor(gasPerMandate ?? DEFAULTS.gasPerMandate));
  const streamMinCharge = amount("streamMinCharge", DEFAULTS.streamMinCharge);
  const streamMaxAgeSeconds = amount("streamMaxAgeSeconds", DEFAULTS.streamMaxAgeSeconds);

  if (
    issues.length > 0 ||
    schedule === undefined ||
    intervalSeconds === undefined ||
    typeof chainSelectorName !== "string" ||
    hub === undefined ||
    charger === undefined ||
    pageSize === undefined ||
    maxBatch === undefined ||
    gasPerMandate === undefined ||
    streamMinCharge === undefined ||
    streamMaxAgeSeconds === undefined
  ) {
    return { issues };
  }
  return {
    value: {
      schedule,
      intervalSeconds,
      chainSelectorName,
      hub,
      charger,
      pageSize,
      maxBatch,
      gasPerMandate,
      policy: { streamMinCharge, streamMaxAgeSeconds, intervalSeconds: BigInt(intervalSeconds) },
    },
  };
}

/**
 * `parseConfig` as a Standard Schema (v1), the interface the SDK's `Runner.newRunner` validates
 * `configSchema` through. A failed parse surfaces there as "Config validation failed" with every
 * issue listed.
 */
export const configSchema = {
  "~standard": {
    version: 1,
    vendor: "weir",
    validate: (value: unknown): ConfigResult => parseConfig(value),
  },
} as const;
