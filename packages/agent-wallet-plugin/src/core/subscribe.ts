/**
 * Subscribing: a plan becomes two signatures (three from savings) and one relayed transaction,
 * exactly as the web checkout does it.
 *
 * 1. An EIP-2612 permit letting the hub draw the mandate's lifetime cap on top of whatever the payer
 *    already allows it, since one allowance serves every mandate on the asset. From savings, the cap
 *    is counted in the vault shares it would take to withdraw it today.
 * 2. From savings only: a permit on the asset for the same cap, the backup the hub pays a charge
 *    from when the vault cannot.
 * 3. The mandate's terms under the hub's domain, with a fresh 256-bit nonce.
 *
 * The relayer submits them all in one transaction, so the payer needs no MON and no gas at all.
 * {@link prepareInstall} reads and builds everything without signing, which is the whole of a dry
 * run; {@link signInstall} and {@link installRequest} turn it into the request the API takes.
 */

import {
  API_ROUTES,
  createMandateTypedData,
  explorerUrl,
  hubDomain,
  networkFor,
  permitTypedData,
  randomNonce,
  type CheckoutResponse,
  type InstallRequest,
  type MandateTerms,
  type MonadChainId,
} from "@weir/shared";
import { isAddressEqual, maxUint256, zeroAddress, type Address, type Hex } from "viem";

import { chainOf } from "./settings.js";
import type { Deps } from "./deps.js";
import { WeirError } from "./errors.js";
import { parsePlanRef } from "./inputs.js";
import { toJson, type Json } from "./json.js";
import { summarizePlan, type PlanSummary } from "./plan.js";
import type { SignRequest, Signer } from "./signer.js";
import { firstCharge, SIGNATURE_WINDOW, termsFor, toWire } from "./terms.js";
import { dateLong, money } from "./words.js";

export interface SubscribeOptions {
  /** A checkout link or a plan id. */
  planRef: string;
  /** Draw from the savings vault over the plan's asset, as the checkout's "Pay from savings" does. */
  fromSavings: boolean;
  /** The key that may pause, resume and stop; the payer when absent, the zero address for none. */
  manager?: Address;
}

export interface InstallPlan {
  checkout: CheckoutResponse;
  summary: PlanSummary;
  chainId: MonadChainId;
  payer: Address;
  terms: MandateTerms;
  funds: {
    from: "balance" | "savings";
    /** Base units of the asset the payer can pay with from that source now. */
    available: bigint;
    firstCharge: bigint;
    enough: boolean;
  };
  permit: { token: Address; value: bigint; nonce: bigint; deadline: number; request: SignRequest };
  /** From savings only: the permit on the asset a charge falls back to when the vault cannot pay. */
  backup?: { value: bigint; nonce: bigint; deadline: number; request: SignRequest };
  mandate: { nonce: bigint; deadline: number; request: SignRequest };
}

/** Reads the plan and the chain and builds both signatures' typed data. Signs nothing. */
export async function prepareInstall(deps: Deps, options: SubscribeOptions, payer: Address): Promise<InstallPlan> {
  const planId = parsePlanRef(options.planRef);
  const checkout = await deps.api.checkout(planId);
  const chainId = chainOf(checkout.chainId, deps.settings);
  const { plan, hub } = checkout;

  if (!plan.active) {
    throw new WeirError(
      "PLAN_INACTIVE",
      `${plan.merchant.name} has paused ${plan.name} and is not taking new subscribers`,
      "Nothing was signed. Ask the business when it reopens.",
    );
  }
  const vault = options.fromSavings ? checkout.savingsVault?.address : undefined;
  if (options.fromSavings && vault === undefined) {
    throw new WeirError(
      "NO_SAVINGS",
      `${plan.assetSymbol} has no savings vault on ${networkFor(chainId).label}, so ${plan.name} cannot be paid from savings`,
      "Subscribe without --from-savings to pay from the wallet's balance.",
    );
  }

  const now = deps.now();
  const deadline = now + SIGNATURE_WINDOW;
  const terms = termsFor(plan, { manager: options.manager ?? payer, now, ...(vault === undefined ? {} : { vault }) });
  const chain = deps.chain(chainId);
  const token = vault ?? plan.asset;

  // Independent reads, made together: they batch into one call to the chain. From savings, the
  // backup permit needs the same three facts about the asset, read in the same batch.
  const [needed, current, domain, permitNonce, available, backupFacts] = await Promise.all([
    vault === undefined ? Promise.resolve(terms.maxTotal) : chain.previewWithdraw(vault, terms.maxTotal),
    chain.allowance(token, payer, hub),
    chain.permitDomain(token),
    chain.permitNonce(token, payer),
    vault === undefined ? chain.balanceOf(plan.asset, payer) : chain.vaultValue(vault, payer),
    vault === undefined
      ? Promise.resolve(undefined)
      : Promise.all([chain.allowance(plan.asset, payer, hub), chain.permitDomain(plan.asset), chain.permitNonce(plan.asset, payer)]),
  ]);
  const capped = (allowed: bigint, more: bigint) => (allowed + more > maxUint256 ? maxUint256 : allowed + more);
  const value = capped(current, needed);
  const first = firstCharge(plan);
  const summary = summarizePlan(checkout, chainId, now, deps.timeZone);

  const permitData = permitTypedData({
    token: { address: token, permit: domain },
    chainId,
    owner: payer,
    spender: hub,
    value,
    nonce: permitNonce,
    deadline: BigInt(deadline),
  });
  let backup: InstallPlan["backup"];
  if (backupFacts !== undefined) {
    const [assetAllowance, assetDomain, assetNonce] = backupFacts;
    const backupValue = capped(assetAllowance, terms.maxTotal);
    backup = {
      value: backupValue,
      nonce: assetNonce,
      deadline,
      request: {
        typedData: permitTypedData({
          token: { address: plan.asset, permit: assetDomain },
          chainId,
          owner: payer,
          spender: hub,
          value: backupValue,
          nonce: assetNonce,
          deadline: BigInt(deadline),
        }),
        summary: `As a backup, let Weir's hub draw up to ${money(backupValue)} of ${plan.assetSymbol} from this wallet, used only when savings cannot pay a charge for ${plan.name}`,
      },
    };
  }

  const mandateNonce = randomNonce();
  const mandateData = createMandateTypedData({
    domain: hubDomain({ name: checkout.domainName, chainId, address: hub }),
    payer,
    terms,
    nonce: mandateNonce,
    deadline: BigInt(deadline),
  });

  const permitSummary =
    vault === undefined
      ? `Let Weir's hub draw up to ${money(value)} of ${plan.assetSymbol} from this wallet, ${money(needed)} of it for ${plan.name}`
      : `Let Weir's hub draw from savings, about ${money(terms.maxTotal)} for ${plan.name} (up to ${value} ${checkout.savingsVault?.symbol ?? "vault"} share units in all)`;
  const mandateSummary = `Subscribe to ${plan.name} from ${plan.merchant.name}: ${summary.words.price}, at most ${money(plan.maxTotal)} in total, until ${dateLong(Number(terms.expiresAt), deps.timeZone)}`;

  return {
    checkout,
    summary,
    chainId,
    payer,
    terms,
    funds: { from: vault === undefined ? "balance" : "savings", available, firstCharge: first, enough: available >= first },
    permit: { token, value, nonce: permitNonce, deadline, request: { typedData: permitData, summary: permitSummary } },
    ...(backup === undefined ? {} : { backup }),
    mandate: { nonce: mandateNonce, deadline, request: { typedData: mandateData, summary: mandateSummary } },
  };
}

/** The body of `POST /v1/relay/install` for a plan and its signatures, the backup's when it has one. */
export function installRequest(plan: InstallPlan, permitSignature: Hex, mandateSignature: Hex, backupSignature?: Hex): InstallRequest {
  return {
    permit: {
      token: plan.permit.token,
      owner: plan.payer,
      value: plan.permit.value.toString(),
      deadline: plan.permit.deadline,
      signature: permitSignature,
    },
    ...(plan.backup === undefined || backupSignature === undefined
      ? {}
      : {
          backupPermit: {
            token: plan.terms.asset,
            owner: plan.payer,
            value: plan.backup.value.toString(),
            deadline: plan.backup.deadline,
            signature: backupSignature,
          },
        }),
    payer: plan.payer,
    terms: toWire(plan.terms),
    nonce: plan.mandate.nonce.toString(),
    deadline: plan.mandate.deadline,
    signature: mandateSignature,
  };
}

/** Signs the permit, the backup permit when there is one, then the mandate. The wallet may ask for approval of each. */
export async function signInstall(plan: InstallPlan, signer: Signer): Promise<InstallRequest> {
  if (!isAddressEqual(signer.address, plan.payer)) {
    throw new WeirError("SIGNING_FAILED", `The plan was built for ${plan.payer} but the signer is ${signer.address}`, "Run the command again.");
  }
  const permitSignature = await signer.signTypedData(plan.permit.request);
  const backupSignature = plan.backup === undefined ? undefined : await signer.signTypedData(plan.backup.request);
  const mandateSignature = await signer.signTypedData(plan.mandate.request);
  return installRequest(plan, permitSignature, mandateSignature, backupSignature);
}

export interface Installed {
  mandateId: string;
  transaction: Hex;
  explorerUrl: string;
}

export async function install(deps: Deps, plan: InstallPlan, request: InstallRequest): Promise<Installed> {
  const response = await deps.api.install(request);
  return {
    mandateId: response.mandateId,
    transaction: response.transactions.create,
    explorerUrl: explorerUrl(plan.chainId, "tx", response.transactions.create),
  };
}

/** Refuses a plan the payer cannot fund yet, before anything is signed. */
export function requireFunds(plan: InstallPlan): void {
  if (plan.funds.enough) return;
  const { summary } = plan;
  const source = plan.funds.from === "savings" ? "savings" : "balance";
  const testnet = plan.chainId === 10143;
  throw new WeirError(
    "INSUFFICIENT_FUNDS",
    `This wallet's ${source} holds ${money(plan.funds.available)} of ${summary.asset.symbol}, and the first charge is ${money(plan.funds.firstCharge)}`,
    plan.funds.from === "savings"
      ? "Move money into savings with `mm weir savings --in <dollars>`, or subscribe without --from-savings."
      : testnet
        ? "Get test dollars with `mm weir faucet`, then subscribe again."
        : `Send ${summary.asset.symbol} to ${plan.payer} on ${summary.network.label}, then subscribe again.`,
  );
}

export interface SubscribeReport {
  dryRun: boolean;
  plan: PlanSummary;
  payer: Address;
  manager: Address;
  paysFrom: "balance" | "savings";
  funds: { available: string; firstCharge: string; enough: boolean };
  /** A dry run: the typed data the wallet would sign, in order. */
  signatures?: { what: "permit" | "backupPermit" | "mandate"; summary: string; typedData: Json }[];
  /** A dry run: the request that would carry them. */
  request?: { method: "POST"; url: string; body: Json };
  /** A subscribe that ran: the new mandate and the transaction that created it. */
  mandateId?: string;
  transaction?: Hex;
  explorerUrl?: string;
}

function baseReport(plan: InstallPlan, dryRun: boolean): SubscribeReport {
  return {
    dryRun,
    plan: plan.summary,
    payer: plan.payer,
    manager: plan.terms.manager,
    paysFrom: plan.funds.from,
    funds: { available: plan.funds.available.toString(), firstCharge: plan.funds.firstCharge.toString(), enough: plan.funds.enough },
  };
}

export function dryRunReport(deps: Deps, plan: InstallPlan): SubscribeReport {
  const placeholder = installRequest(plan, "0x" as Hex, "0x" as Hex, "0x" as Hex);
  const body = toJson({
    ...placeholder,
    permit: { ...placeholder.permit, signature: "<the wallet's permit signature>" },
    ...(placeholder.backupPermit === undefined
      ? {}
      : { backupPermit: { ...placeholder.backupPermit, signature: "<the wallet's backup permit signature>" } }),
    signature: "<the wallet's mandate signature>",
  });
  return {
    ...baseReport(plan, true),
    signatures: [
      { what: "permit", summary: plan.permit.request.summary, typedData: toJson(plan.permit.request.typedData) },
      ...(plan.backup === undefined
        ? []
        : [{ what: "backupPermit" as const, summary: plan.backup.request.summary, typedData: toJson(plan.backup.request.typedData) }]),
      { what: "mandate", summary: plan.mandate.request.summary, typedData: toJson(plan.mandate.request.typedData) },
    ],
    request: { method: "POST", url: `${deps.api.baseUrl}${API_ROUTES.install}`, body },
  };
}

export function installedReport(plan: InstallPlan, installed: Installed): SubscribeReport {
  return { ...baseReport(plan, false), mandateId: installed.mandateId, transaction: installed.transaction, explorerUrl: installed.explorerUrl };
}

/** True when `manager` is the zero address, meaning the mandate has none. */
export function noManager(manager: Address): boolean {
  return isAddressEqual(manager, zeroAddress);
}
