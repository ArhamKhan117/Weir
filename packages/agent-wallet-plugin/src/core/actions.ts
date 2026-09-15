/**
 * Stopping, pausing and resuming: one `MandateAction` signature, relayed. The hub's `actWithSig`
 * accepts it from the mandate's payer or its manager, so the wallet may be either.
 *
 * Before anything is signed the mandate is read from the hub itself, so a request the hub would
 * refuse is refused here in plain words instead: a mandate that is not this wallet's, one already
 * stopped, or a pause or resume asked of a periodic mandate, which the hub only allows on streams.
 */

import { ACTIONS, API_ROUTES, actionTypedData, explorerUrl, randomNonce, type ActionRequest, type MandateAction, type MandateRecord, type MandateView, type MonadChainId } from "@weir/shared";
import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";

import type { Deps } from "./deps.js";
import { WeirError } from "./errors.js";
import { toJson, type Json } from "./json.js";
import { chainOf } from "./settings.js";
import type { SignRequest, Signer } from "./signer.js";
import { SIGNATURE_WINDOW } from "./terms.js";
import { mandatePricePhrase } from "./words.js";

/** What a person types, and the hub action each one is. */
export const VERBS = { stop: "cancel", pause: "pause", resume: "resume" } as const satisfies Record<string, MandateAction>;
export type Verb = keyof typeof VERBS;

export interface ActionPlan {
  verb: Verb;
  action: MandateAction;
  chainId: MonadChainId;
  hub: Address;
  mandate: MandateRecord;
  /** How the wallet is entitled to act: as the payer, or as the manager. */
  role: "payer" | "manager";
  signer: Address;
  /** "Studio Pro from Lumen Studio", or "mandate #3" when the index has no plan for it. */
  title: string;
  nonce: bigint;
  deadline: number;
  request: SignRequest;
}

/** Reads the mandate and the hub's domain, checks the action makes sense, and builds the typed data. */
export async function prepareAction(deps: Deps, input: { mandateId: bigint; verb: Verb }, signer: Address): Promise<ActionPlan> {
  const { mandateId, verb } = input;
  const action = VERBS[verb];
  const health = await deps.api.health();
  const chainId = chainOf(health.chainId, deps.settings);
  const chain = deps.chain(chainId);

  // The chain is the truth about the mandate; the index only adds the plan's name.
  const [mandate, domain, indexed] = await Promise.all([
    chain.mandate(health.hub, mandateId),
    chain.hubDomain(health.hub),
    deps.api.payer(signer).catch(() => undefined),
  ]);
  if (mandate === undefined) {
    throw new WeirError("MANDATE_NOT_FOUND", `No mandate #${mandateId} exists on Weir's hub`, "See `mm weir list` for this wallet's mandates.");
  }
  const view = indexed?.mandates.find((candidate) => candidate.id === mandateId.toString());
  const title = titleOf(mandateId, view);

  const role = isAddressEqual(mandate.payer, signer)
    ? "payer"
    : !isAddressEqual(mandate.manager, zeroAddress) && isAddressEqual(mandate.manager, signer)
      ? "manager"
      : undefined;
  if (role === undefined) {
    throw new WeirError(
      "NOT_YOURS",
      `Mandate #${mandateId} is paid by ${mandate.payer}, and this wallet (${signer}) is neither its payer nor its manager`,
      "Select the paying wallet with `mm wallet select`, or see `mm weir list` for this wallet's mandates.",
    );
  }
  checkAllowed(verb, mandate, title);

  const nonce = randomNonce();
  const deadline = deps.now() + SIGNATURE_WINDOW;
  const typedData = actionTypedData({ domain, mandateId, action, nonce, deadline: BigInt(deadline) });
  const summary = `${verb === "stop" ? "Stop" : verb === "pause" ? "Pause" : "Resume"} ${title} (Weir mandate #${mandateId})`;

  return { verb, action, chainId, hub: health.hub, mandate, role, signer, title, nonce, deadline, request: { typedData, summary } };
}

/** The refusals the hub would give, named before anything is signed. */
export function checkAllowed(verb: Verb, mandate: MandateRecord, title: string): void {
  const id = mandate.id;
  if (mandate.status === "Cancelled") {
    throw new WeirError("ALREADY_STOPPED", `${title} (mandate #${id}) is already stopped`, "Nothing more can be charged on it.");
  }
  if (verb === "stop") return;
  if (mandate.period !== 0) {
    throw new WeirError(
      "NOT_A_STREAM",
      `Pause and resume apply to per-second streams only; ${title} (mandate #${id}) is a periodic mandate, ${mandatePricePhrase(mandate)}`,
      `Stop it instead with \`mm weir stop ${id}\`.`,
    );
  }
  if (verb === "pause" && mandate.pausedAt !== 0n) {
    throw new WeirError("ALREADY_PAUSED", `${title} (mandate #${id}) is already paused`, `Resume it with \`mm weir resume ${id}\`.`);
  }
  if (verb === "resume" && mandate.pausedAt === 0n) {
    throw new WeirError("NOT_PAUSED", `${title} (mandate #${id}) is running, not paused`, `Pause it with \`mm weir pause ${id}\`.`);
  }
}

export function titleOf(mandateId: bigint, view: MandateView | undefined): string {
  return view?.plan === undefined ? `mandate #${mandateId}` : `${view.plan.name} from ${view.plan.merchantName}`;
}

export function actionRequest(plan: ActionPlan, signature: Hex): ActionRequest {
  return {
    mandateId: plan.mandate.id.toString(),
    action: plan.action,
    signer: plan.signer,
    nonce: plan.nonce.toString(),
    deadline: plan.deadline,
    signature,
  };
}

export interface ActionReport {
  dryRun: boolean;
  mandateId: string;
  title: string;
  verb: Verb;
  /** The hub's action code, as `ACTION_*` in the contract. */
  actionCode: number;
  signer: Address;
  role: "payer" | "manager";
  chainId: MonadChainId;
  /** A dry run: what the wallet would sign and the request that would carry it. */
  signature?: { summary: string; typedData: Json };
  request?: { method: "POST"; url: string; body: Json };
  transaction?: Hex;
  explorerUrl?: string;
}

function baseReport(plan: ActionPlan, dryRun: boolean): ActionReport {
  return {
    dryRun,
    mandateId: plan.mandate.id.toString(),
    title: plan.title,
    verb: plan.verb,
    actionCode: ACTIONS[plan.action],
    signer: plan.signer,
    role: plan.role,
    chainId: plan.chainId,
  };
}

export function actionDryRun(deps: Deps, plan: ActionPlan): ActionReport {
  return {
    ...baseReport(plan, true),
    signature: { summary: plan.request.summary, typedData: toJson(plan.request.typedData) },
    request: {
      method: "POST",
      url: `${deps.api.baseUrl}${API_ROUTES.action}`,
      body: toJson({ ...actionRequest(plan, "0x"), signature: "<the wallet's signature>" }),
    },
  };
}

/** Signs the action with the wallet. */
export async function signAction(plan: ActionPlan, signer: Signer): Promise<ActionRequest> {
  if (!isAddressEqual(signer.address, plan.signer)) {
    throw new WeirError("SIGNING_FAILED", `The action was built for ${plan.signer} but the signer is ${signer.address}`, "Run the command again.");
  }
  return actionRequest(plan, await signer.signTypedData(plan.request));
}

/** Has the relayer submit a signed action. */
export async function relayAction(deps: Deps, plan: ActionPlan, request: ActionRequest): Promise<ActionReport> {
  const { transaction } = await deps.api.action(request);
  return { ...baseReport(plan, false), transaction, explorerUrl: explorerUrl(plan.chainId, "tx", transaction) };
}
