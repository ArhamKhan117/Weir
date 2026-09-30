/**
 * Turning a plan into a mandate, and a person's taps into signatures the relayer submits.
 *
 * Installing is two signatures from the owner key under one passkey prompt: an EIP-2612 permit
 * letting the hub pull up to the mandate's lifetime cap, and the mandate's terms. A mandate drawn
 * from savings signs a third, a permit on the dollars themselves, the backup the hub pays from when
 * the vault cannot. Stopping, pausing and resuming are one signature from the session key, with no
 * prompt at all.
 */

import {
  actionTypedData,
  createMandateTypedData,
  hubDomain,
  permitTypedData,
  randomNonce,
  refFromString,
  type CheckoutResponse,
  type MandateAction,
  type MandateTerms,
  type Plan,
  type SignedPermit,
  type WireTerms,
} from "@weir/shared";
import { getAddress, maxUint256, zeroAddress, type Address, type Hex, type LocalAccount } from "viem";

import { api } from "./api";
import { allowance, client, permitNonce, vaultAbi } from "./chain";
import { CHAIN_ID, DEPLOYMENT } from "./config";
import { permitDomainFor } from "./permit";

const DAY = 86_400;
/** How long a signature stays valid: long enough for a slow relay, short enough to be useless later. */
export const SIGNATURE_WINDOW = 15 * 60;

/** The terms a checkout installs for `plan`, with the session key as manager. */
export function termsFor(plan: Plan, options: { manager: Address; vault?: Address; now?: number }): MandateTerms {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return {
    merchant: plan.merchant.payoutAddress,
    asset: plan.asset,
    vault: options.vault ?? zeroAddress,
    manager: options.manager,
    amount: BigInt(plan.amount),
    period: plan.mode === "streaming" ? 0 : plan.period,
    startAt: plan.trialDays > 0 ? BigInt(now + plan.trialDays * DAY) : 0n,
    maxPerCharge: BigInt(plan.maxPerCharge),
    maxTotal: BigInt(plan.maxTotal),
    expiresAt: BigInt(now + plan.termSeconds),
    ref: refFromString(plan.id),
  };
}

export function toWire(terms: MandateTerms): WireTerms {
  return {
    merchant: terms.merchant,
    asset: terms.asset,
    vault: terms.vault,
    manager: terms.manager,
    amount: terms.amount.toString(),
    period: terms.period,
    startAt: Number(terms.startAt),
    maxPerCharge: terms.maxPerCharge.toString(),
    maxTotal: terms.maxTotal.toString(),
    expiresAt: Number(terms.expiresAt),
    ref: terms.ref,
  };
}

/**
 * Signs the permit and the terms with the owner key, then has the relayer submit both to `target`,
 * the hub a checkout or a support page names. Returns the new mandate id and the install
 * transaction.
 */
export async function signAndInstall(
  owner: LocalAccount,
  target: Pick<CheckoutResponse, "hub" | "domainName">,
  terms: MandateTerms,
): Promise<{ mandateId: string; transaction: Hex; charged: boolean }> {
  const hub = target.hub;
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + SIGNATURE_WINDOW;

  // What the permit covers: the mandate's lifetime cap on top of whatever this payer already
  // allows the hub, since one allowance serves every mandate on the asset. From a vault, the cap is
  // counted in the shares it would take to withdraw it today, which only falls as savings earn.
  const fromSavings = terms.vault !== zeroAddress;
  const token = fromSavings ? terms.vault : terms.asset;
  // Independent reads, made together: a person is waiting on each round trip. A savings mandate's
  // backup permit needs the same three facts about the asset, read in the same round.
  const [needed, current, domain, permitNonceValue, backup] = await Promise.all([
    fromSavings
      ? client.readContract({ address: terms.vault, abi: vaultAbi, functionName: "previewWithdraw", args: [terms.maxTotal] })
      : Promise.resolve(terms.maxTotal),
    allowance(token, owner.address, hub),
    permitDomainFor(token),
    permitNonce(token, owner.address),
    fromSavings
      ? Promise.all([allowance(terms.asset, owner.address, hub), permitDomainFor(terms.asset), permitNonce(terms.asset, owner.address)])
      : Promise.resolve(undefined),
  ]);

  const signPermit = (address: Address, permitDomain: typeof domain, value: bigint, nonce: bigint) =>
    owner.signTypedData(
      permitTypedData({
        token: { address, permit: permitDomain },
        chainId: CHAIN_ID,
        owner: owner.address,
        spender: hub,
        value,
        nonce,
        deadline: BigInt(deadline),
      }),
    );
  const capped = (allowed: bigint, more: bigint) => (allowed + more > maxUint256 ? maxUint256 : allowed + more);

  const value = capped(current, needed);
  const permitSignature = await signPermit(token, domain, value, permitNonceValue);

  // The backup: the same lifetime cap, in dollars, on top of what the asset already allows.
  let backupPermit: SignedPermit | undefined;
  if (backup !== undefined) {
    const [assetAllowance, assetDomain, assetNonce] = backup;
    const backupValue = capped(assetAllowance, terms.maxTotal);
    backupPermit = {
      token: terms.asset,
      owner: owner.address,
      value: backupValue.toString(),
      deadline,
      signature: await signPermit(terms.asset, assetDomain, backupValue, assetNonce),
    };
  }

  const nonce = randomNonce();
  const mandateSignature = await owner.signTypedData(
    createMandateTypedData({
      domain: hubDomain({ name: target.domainName, chainId: CHAIN_ID, address: hub }),
      payer: owner.address,
      terms,
      nonce,
      deadline: BigInt(deadline),
    }),
  );

  const response = await api.install({
    permit: { token, owner: owner.address, value: value.toString(), deadline, signature: permitSignature },
    ...(backupPermit === undefined ? {} : { backupPermit }),
    payer: owner.address,
    terms: toWire(terms),
    nonce: nonce.toString(),
    deadline,
    signature: mandateSignature,
  });
  return { mandateId: response.mandateId, transaction: response.transactions.create, charged: response.charged === true };
}

/** Signs a cancel, pause or resume with `signer` (the session key, or the owner) and relays it. */
export async function signAndAct(signer: LocalAccount, mandateId: string, action: MandateAction): Promise<Hex> {
  const nonce = randomNonce();
  const deadline = Math.floor(Date.now() / 1000) + SIGNATURE_WINDOW;
  const signature = await signer.signTypedData(
    actionTypedData({
      domain: hubDomain({ name: DEPLOYMENT.eip712.name, chainId: CHAIN_ID, address: DEPLOYMENT.contracts.MandateHub }),
      mandateId: BigInt(mandateId),
      action,
      nonce,
      deadline: BigInt(deadline),
    }),
  );
  const response = await api.action({
    mandateId,
    action,
    signer: getAddress(signer.address),
    nonce: nonce.toString(),
    deadline,
    signature,
  });
  return response.transaction;
}
