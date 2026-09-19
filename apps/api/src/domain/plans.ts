/**
 * Plan validation: a plan is accepted only if every mandate installed from it would be accepted
 * by `MandateHub._create`.
 *
 * The checkout builds a mandate from the plan as `startAt = install + trialDays days` and
 * `expiresAt = install + termSeconds`, so the rules below are the hub's, restated over the plan's
 * fields: an accepted asset, a non-zero amount, a periodic period within 60 seconds to one year
 * (zero marks a stream), a per-charge cap that covers one periodic charge, a lifetime cap that
 * covers at least `amount`, and an expiry at or after the first charge (strictly after, for a
 * stream, which cannot start and end in the same second).
 */

import type { CreatePlanRequest, PlanMode } from "@weir/shared";
import type { Address } from "viem";

import { badRequest } from "../http/errors.js";
import {
  field,
  readAddress,
  readInteger,
  readObject,
  readOneOf,
  readText,
  readUnits,
  MAX_UINT96,
} from "../http/validate.js";

export const MIN_PERIOD = 60;
export const MAX_PERIOD = 31_536_000;
export const DAY = 86_400;
export const MAX_TRIAL_DAYS = 365;
/** Ten years. A mandate is a standing authorization; asking for more than this is a mistake. */
export const MAX_TERM_SECONDS = 315_360_000;
export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 500;

export interface ValidPlan {
  name: string;
  description: string;
  asset: Address;
  assetSymbol: string;
  mode: PlanMode;
  amount: bigint;
  period: number;
  trialDays: number;
  maxPerCharge: bigint;
  maxTotal: bigint;
  termSeconds: number;
}

const PLAN_FIELDS = [
  "name",
  "description",
  "asset",
  "mode",
  "amount",
  "period",
  "trialDays",
  "maxPerCharge",
  "maxTotal",
  "termSeconds",
] as const satisfies readonly (keyof CreatePlanRequest)[];

/**
 * @param symbolFor the recorded symbol of an accepted asset, `undefined` for any other address.
 * @throws a 400 naming the first field the hub would refuse.
 */
export function validatePlan(body: unknown, symbolFor: (asset: Address) => string | undefined): ValidPlan {
  const input = readObject(body, "body", PLAN_FIELDS);

  const name = field(input, "name", (v, p) => readText(v, p, { min: 1, max: MAX_NAME }));
  const description = field(input, "description", (v, p) => readText(v, p, { max: MAX_DESCRIPTION }));
  const asset = field(input, "asset", readAddress);
  const assetSymbol = symbolFor(asset);
  if (assetSymbol === undefined) throw badRequest(`asset ${asset} is not one the hub accepts`);

  const mode = field(input, "mode", (v, p) => readOneOf(v, p, ["periodic", "streaming"] as const));
  const amount = field(input, "amount", (v, p) => readUnits(v, p, { min: 1n, max: MAX_UINT96 }));
  const period = field(input, "period", (v, p) => readInteger(v, p));
  const trialDays = field(input, "trialDays", (v, p) => readInteger(v, p, { max: MAX_TRIAL_DAYS }));
  const maxPerCharge = field(input, "maxPerCharge", (v, p) => readUnits(v, p, { min: 1n, max: MAX_UINT96 }));
  const maxTotal = field(input, "maxTotal", (v, p) => readUnits(v, p, { min: 1n, max: MAX_UINT96 }));
  const termSeconds = field(input, "termSeconds", (v, p) => readInteger(v, p, { min: 1, max: MAX_TERM_SECONDS }));

  if (mode === "periodic") {
    if (period < MIN_PERIOD || period > MAX_PERIOD) {
      throw badRequest(`period must be between ${MIN_PERIOD} and ${MAX_PERIOD} seconds for a periodic plan`);
    }
    if (maxPerCharge < amount) throw badRequest("maxPerCharge must be at least amount for a periodic plan");
  } else if (period !== 0) {
    throw badRequest("period must be 0 for a streaming plan; amount is the rate per second");
  }
  if (maxTotal < amount) throw badRequest("maxTotal must be at least amount");

  const trialSeconds = trialDays * DAY;
  if (mode === "periodic" ? termSeconds < trialSeconds : termSeconds <= trialSeconds) {
    throw badRequest(
      mode === "periodic"
        ? "termSeconds must reach the first charge, at the end of the trial"
        : "termSeconds must run past the end of the trial",
    );
  }

  return { name, description, asset, assetSymbol, mode, amount, period, trialDays, maxPerCharge, maxTotal, termSeconds };
}
