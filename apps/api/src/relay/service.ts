/**
 * What the relay routes do, built server side from validated input.
 *
 * A request never names a contract or a function: the install becomes `createMandateWithSig` on
 * the hub, the permit becomes `permit(owner, hub, value, deadline, v, r, s)` on the token the
 * mandate draws from, and so on. The {@link Relayer} then checks the calldata against the policy
 * anyway, so a mistake here is refused rather than signed.
 *
 * An install is one transaction when the network has Multicall3: the permits and the mandate,
 * bundled. A mandate drawn from savings may carry a second permit, on its asset, the backup the
 * hub pays from when the vault cannot. One read-only call first reports what each part would do,
 * so a bad mandate signature costs nothing and comes back by name; each permit is allowed to fail
 * inside the bundle, because a permit someone else already submitted fails harmlessly, and it is
 * refused only when it fails and the allowance does not already cover it. Without Multicall3 they
 * are sent one after another.
 */

import {
  ACTIONS,
  mandateHubAbi,
  savingsRouterAbi,
  stablecoinAbi,
  VAULT_ACCRUAL_GAS,
  type FaucetResponse,
  type InstallResponse,
  type PayoutResponse,
  type RelayResponse,
} from "@weir/shared";
import {
  decodeFunctionResult,
  encodeFunctionData,
  isAddressEqual,
  parseEventLogs,
  parseSignature,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import { badRequest, notFound } from "../http/errors.js";
import type { Logger } from "../log.js";
import { savingsVaultFor, type ApiDeployment } from "../network.js";
import { bundle } from "./policy.js";
import { RejectedOnChainError, type RelayChain, type Relayer, type Submitted } from "./relayer.js";
import type { ActionInput, InstallInput, PayoutInput, PermitInput, SavingsInput, SetManagerInput } from "./requests.js";

/** What the relayer needs to know about a mandate before relaying a pause or a stop. */
export interface StreamState {
  streaming: boolean;
  paused: boolean;
  fromVault: boolean;
  /** What a charge would take at the latest block. */
  quote: bigint;
}

export type StreamReader = (mandateId: bigint) => Promise<StreamState>;

/**
 * Gas a stream's settlement adds when the estimate could not see it: a token transfer to the
 * merchant, measured at about 47,000 on Monad Testnet, with room.
 */
export const TOKEN_SETTLEMENT_GAS = 80_000n;

/**
 * A payment that is a single charge, due the moment it exists: a periodic mandate whose lifetime
 * cap is one charge, starting now.
 */
export function isOneChargeDueNow(terms: InstallInput["terms"], nowSeconds: number): boolean {
  return terms.period > 0 && terms.maxTotal === terms.amount && terms.startAt <= BigInt(nowSeconds);
}

/** The mandate id a simulated `createMandateWithSig` returned. */
function createdId(returnData: Hex | undefined): bigint | undefined {
  if (returnData === undefined || returnData === "0x") return undefined;
  try {
    return decodeFunctionResult({ abi: mandateHubAbi, functionName: "createMandateWithSig", data: returnData });
  } catch {
    return undefined;
  }
}

/** A 65-byte permit signature as `permit(..., v, r, s)` takes it. */
function splitPermitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const { r, s, v, yParity } = parseSignature(signature);
  return { v: v === undefined ? yParity + 27 : Number(v), r, s };
}

export class RelayService {
  constructor(
    private readonly relayer: Relayer,
    private readonly chain: Pick<RelayChain, "allowance" | "call">,
    private readonly deployment: ApiDeployment,
    private readonly logger: Logger,
    private readonly streams?: StreamReader,
    /** The same for a settlement drawn from a vault; a Morpho vault's withdrawal is about 440,000. */
    private readonly vaultSettlementGas: bigint = 500_000n,
  ) {}

  get address(): Address {
    return this.relayer.address;
  }

  get queueDepth(): number {
    return this.relayer.queueDepth;
  }

  drain(): Promise<void> {
    return this.relayer.drain();
  }

  private get hub(): Address {
    return this.deployment.hub;
  }

  /** The permit, refused unless it is the payer's, on an allowed token, for what the mandate draws. */
  private checkPermit(input: InstallInput, permit: PermitInput): void {
    if (!isAddressEqual(permit.owner, input.payer)) throw badRequest("permit.owner must be the payer");
    const allowed = this.relayer.policy.permitTokens.some((token) => isAddressEqual(token, permit.token));
    if (!allowed) throw badRequest("permit.token is not an accepted asset or a known savings vault");
    const source = isAddressEqual(input.terms.vault, zeroAddress) ? input.terms.asset : input.terms.vault;
    if (!isAddressEqual(permit.token, source)) {
      throw badRequest(
        isAddressEqual(input.terms.vault, zeroAddress)
          ? "permit.token must be terms.asset, the token the mandate draws from"
          : "permit.token must be terms.vault, the shares the mandate draws from",
      );
    }
  }

  /** The backup permit: only for a mandate drawn from savings, the payer's, on the mandate's asset. */
  private checkBackupPermit(input: InstallInput, permit: PermitInput): void {
    if (isAddressEqual(input.terms.vault, zeroAddress)) {
      throw badRequest("backupPermit is only for a mandate drawn from savings; the permit already covers the asset");
    }
    if (!isAddressEqual(permit.owner, input.payer)) throw badRequest("backupPermit.owner must be the payer");
    if (!isAddressEqual(permit.token, input.terms.asset)) {
      throw badRequest("backupPermit.token must be terms.asset, the dollars a charge falls back to");
    }
  }

  private permitCall(permit: PermitInput): { to: Address; data: Hex } {
    const { v, r, s } = splitPermitSignature(permit.signature);
    return {
      to: permit.token,
      data: encodeFunctionData({
        abi: stablecoinAbi,
        functionName: "permit",
        args: [permit.owner, this.hub, permit.value, BigInt(permit.deadline), v, r, s],
      }),
    };
  }

  /** Submits the permit, or returns `undefined` when the allowance already covers it. */
  private async applyPermit(permit: PermitInput): Promise<Hex | undefined> {
    const covered = async (): Promise<boolean> =>
      (await this.chain.allowance(permit.token, permit.owner, this.hub)) >= permit.value;

    if (await covered()) {
      this.logger.info("permit skipped: the allowance already covers it", { token: permit.token, owner: permit.owner });
      return undefined;
    }
    try {
      return (await this.relayer.submit(this.permitCall(permit), "permit")).hash;
    } catch (error) {
      // Front-run between the read and the send: the permit landed, just not ours.
      if (error instanceof RejectedOnChainError && (await covered())) {
        this.logger.info("permit skipped: submitted by someone else first", { token: permit.token, owner: permit.owner });
        return undefined;
      }
      throw error;
    }
  }

  /**
   * @param admit called once the mandate has simulated and before anything is sent; it throws to
   *        refuse, which is where the per-payer rate limit sits.
   */
  async install(input: InstallInput, admit: () => void = () => undefined): Promise<InstallResponse> {
    if (input.permit !== undefined) this.checkPermit(input, input.permit);
    if (input.backupPermit !== undefined) this.checkBackupPermit(input, input.backupPermit);
    const permits = [input.permit, input.backupPermit].filter((permit): permit is PermitInput => permit !== undefined);

    const create = {
      to: this.hub,
      data: encodeFunctionData({
        abi: mandateHubAbi,
        functionName: "createMandateWithSig",
        args: [input.payer, input.terms, input.nonce, BigInt(input.deadline), input.signature],
      }),
    };
    const multicall = this.relayer.policy.multicall;
    // A payment that is one charge, due now ("send now") goes in the same transaction as its charge.
    const settleNow = multicall !== undefined && isOneChargeDueNow(input.terms, Math.floor(Date.now() / 1000));
    let created: Submitted;
    let permit: Hex | undefined;

    if ((permits.length > 0 || settleNow) && multicall !== undefined) {
      const permitCalls = permits.map((p) => this.permitCall(p));
      const bundleOf = (calls: readonly { to: Address; data: Hex }[], chargeId?: bigint, chargeMustSucceed = false) =>
        bundle(multicall, [
          ...calls.map((call) => ({ ...call, allowFailure: true })),
          { ...create, allowFailure: false },
          ...(chargeId === undefined ? [] : [{ ...this.chargeCall(chargeId), allowFailure: !chargeMustSucceed }]),
        ]);
      // Both are reads, so they run together: what each part would do, and what the bundle costs.
      // The estimate is discarded if the inspection refuses, and a failed estimate waits for the
      // inspection's clearer answer. A bundle that also charges is estimated once its id is known.
      const estimating = settleNow
        ? undefined
        : this.relayer.estimate(bundleOf(permitCalls)).then(
            (gas) => ({ ok: true as const, gas }),
            (error: unknown) => ({ ok: false as const, error }),
          );
      const results = await this.relayer.inspect([...permitCalls, create]);
      const createResult = results.at(-1);
      if (createResult !== undefined && !createResult.success && createResult.revert !== undefined) {
        throw new RejectedOnChainError(createResult.revert);
      }
      // A permit that would fail is fine only when its allowance is already there, which is what a
      // permit someone else submitted first leaves behind; then the bundle goes without it.
      const working: number[] = [];
      for (const [i, p] of permits.entries()) {
        if (results[i]?.success === true) {
          working.push(i);
          continue;
        }
        const covered = (await this.chain.allowance(p.token, p.owner, this.hub)) >= p.value;
        if (!covered) throw new RejectedOnChainError(results[i]?.revert ?? { name: "unknown", detail: "the permit reverts" });
        this.logger.info("permit skipped: the allowance already covers it", { token: p.token, owner: p.owner });
      }
      const workingCalls = working.map((i) => permitCalls[i] as { to: Address; data: Hex });
      // The id the hub will assign, as the simulation saw it. Should another mandate land first,
      // the charge names the wrong one and fails harmlessly, and the keeper charges this one.
      const nextId = settleNow ? createdId(createResult?.returnData) : undefined;
      admit();
      // Estimated with the charge required to succeed: estimating the bundle that lets it fail finds
      // the least gas at which the install goes through, which starves the charge. The bundle sent
      // lets it fail, so a wrong id or anything else about the charge never costs the install.
      const strictEstimate =
        nextId === undefined
          ? undefined
          : await this.relayer.estimate(bundleOf(workingCalls, nextId, true)).catch((error: unknown) => {
              this.logger.warn("the charge with this install would not go through; installing alone", { error: String(error) });
              return undefined;
            });
      if (nextId !== undefined && strictEstimate !== undefined) {
        const accrual = input.terms.vault === zeroAddress ? 0n : VAULT_ACCRUAL_GAS;
        created = await this.relayer.submit(bundleOf(workingCalls, nextId), "install and charge", { estimate: strictEstimate + accrual });
      } else if (nextId !== undefined && working.length > 0) {
        created = await this.relayer.submit(bundleOf(workingCalls), "install");
      } else if (nextId !== undefined) {
        created = await this.relayer.submit(create, "install");
      } else if (estimating !== undefined && working.length === permits.length) {
        const estimate = await estimating;
        if (!estimate.ok) throw estimate.error;
        created = await this.relayer.submit(bundleOf(permitCalls), "install", { estimate: estimate.gas });
      } else if (working.length > 0) {
        created = await this.relayer.submit(bundleOf(workingCalls), "install");
      } else {
        created = await this.relayer.submit(create, "install");
      }
      permit = working.length > 0 ? created.hash : undefined;
    } else {
      // Estimating is simulating: a mandate the hub would refuse is refused here, before anything is sent.
      const estimate = await this.relayer.estimate(create);
      admit();
      for (const p of permits) permit = (await this.applyPermit(p)) ?? permit;
      created = await this.relayer.submit(create, "install", { estimate });
    }

    const logs = parseEventLogs({ abi: mandateHubAbi, logs: [...created.receipt.logs] }).filter((log) => isAddressEqual(log.address, this.hub));
    const event = logs.find((log) => log.eventName === "MandateCreated");
    if (event === undefined) throw new Error(`install ${created.hash} succeeded without a MandateCreated event`);
    const mandateId = event.args.mandateId;
    const charged = logs.some((log) => log.eventName === "Charged" && log.args.mandateId === mandateId);

    return {
      mandateId: mandateId.toString(),
      transactions: { ...(permit === undefined ? {} : { permit }), create: created.hash },
      ...(settleNow ? { charged } : {}),
    };
  }

  private chargeCall(mandateId: bigint): { to: Address; data: Hex } {
    return { to: this.hub, data: encodeFunctionData({ abi: mandateHubAbi, functionName: "charge", args: [mandateId] }) };
  }

  async action(input: ActionInput): Promise<RelayResponse> {
    const call = {
      to: this.hub,
      data: encodeFunctionData({
        abi: mandateHubAbi,
        functionName: "actWithSig",
        args: [input.mandateId, ACTIONS[input.action], input.signer, input.nonce, BigInt(input.deadline), input.signature],
      }),
    };
    // Pausing or stopping a stream settles what it has accrued, and the estimate only covers that
    // when something had accrued at the block it ran against. A stream started or resumed in the
    // same second has accrued nothing there, yet will have by the block that includes the call, so
    // its settlement is allowed for. The two reads run together: no added wait.
    const streams = input.action === "resume" ? undefined : this.streams;
    const [estimate, stream] = await Promise.all([
      this.relayer.estimate(call),
      streams === undefined ? Promise.resolve(undefined) : streams(input.mandateId).catch(() => undefined),
    ]);
    // A settlement from savings also pays the vault's interest accrual, which an estimate in the
    // second of its last touch does not see.
    const settling = stream !== undefined && stream.streaming && !stream.paused;
    const unaccounted = settling && stream.quote === 0n;
    const accrual = settling && stream.fromVault ? VAULT_ACCRUAL_GAS : 0n;
    const settlement = unaccounted ? (stream.fromVault ? this.vaultSettlementGas : TOKEN_SETTLEMENT_GAS) : 0n;
    const gas = estimate + accrual + settlement;
    return { transaction: (await this.relayer.submit(call, input.action, { estimate: gas })).hash };
  }

  async setManager(input: SetManagerInput): Promise<RelayResponse> {
    const call = {
      to: this.hub,
      data: encodeFunctionData({
        abi: mandateHubAbi,
        functionName: "setManagerWithSig",
        args: [input.mandateId, input.manager, input.nonce, BigInt(input.deadline), input.signature],
      }),
    };
    return { transaction: (await this.relayer.submit(call, "set manager")).hash };
  }

  /**
   * Moves the owner's dollars into their savings vault, or back out, through the savings router
   * on the owner's permit. The router takes the permit and fixes where everything goes, so the
   * request names only whose money, which asset and how much.
   *
   * @param admit called once the call has simulated and before it is sent; it throws to refuse,
   *        which is where the per-owner rate limit sits.
   */
  async savings(input: SavingsInput, admit: () => void = () => undefined): Promise<RelayResponse> {
    const router = this.deployment.router;
    if (router === undefined) throw notFound("There is no savings router on this network");
    if (savingsVaultFor(this.deployment, input.asset) === undefined) {
      throw badRequest(`${input.asset} has no savings vault on this network`);
    }
    const { v, r, s } = splitPermitSignature(input.signature);
    const deadline = BigInt(input.deadline);
    const call = {
      to: router,
      data:
        input.direction === "deposit"
          ? encodeFunctionData({
              abi: savingsRouterAbi,
              functionName: "depositFor",
              args: [input.owner, input.asset, input.amount, deadline, v, r, s],
            })
          : encodeFunctionData({
              abi: savingsRouterAbi,
              functionName: "withdrawFor",
              args: [input.owner, input.asset, input.amount, input.maxShares ?? 0n, deadline, v, r, s],
            }),
    };
    // Estimating is simulating: a permit that does not verify, or a balance that falls short, is
    // refused here by name, before the owner's allowance of moves is touched or anything is sent.
    // The move touches the vault, so it carries the vault's interest accrual on top (see
    // `VAULT_ACCRUAL_GAS`).
    const estimate = await this.relayer.estimate(call);
    admit();
    const sent = await this.relayer.submit(call, `savings ${input.direction}`, { estimate: estimate + VAULT_ACCRUAL_GAS });
    return { transaction: sent.hash };
  }

  /**
   * Sends a business's earnings on from a wallet it holds: the wallet's permit names the relayer
   * as spender for exactly `amount`, the relayer submits it (unless that allowance is already
   * there) and then moves the money with `transferFrom`, paying both fees. The balance is checked
   * first and the permit simulated, so a payout that would fail sends nothing.
   *
   * @param admit called once the payout has checked out and before anything is sent.
   */
  async payout(input: PayoutInput, admit: () => void = () => undefined): Promise<PayoutResponse> {
    const spender = this.relayer.address;
    const balance = decodeFunctionResult({
      abi: stablecoinAbi,
      functionName: "balanceOf",
      data: await this.chain.call({ to: input.asset, data: encodeFunctionData({ abi: stablecoinAbi, functionName: "balanceOf", args: [input.owner] }) }),
    });
    if (balance < input.amount) throw badRequest("The wallet holds less than that");
    const { v, r, s } = splitPermitSignature(input.signature);
    const permit = {
      to: input.asset,
      data: encodeFunctionData({ abi: stablecoinAbi, functionName: "permit", args: [input.owner, spender, input.amount, BigInt(input.deadline), v, r, s] }),
    };
    const transfer = {
      to: input.asset,
      data: encodeFunctionData({ abi: stablecoinAbi, functionName: "transferFrom", args: [input.owner, input.to, input.amount] }),
    };
    let permitted: Hex | undefined;
    if ((await this.chain.allowance(input.asset, input.owner, spender)) < input.amount) {
      // Estimating is simulating: a permit that does not verify is refused here, before anything is sent.
      const estimate = await this.relayer.estimate(permit);
      admit();
      permitted = (await this.relayer.submit(permit, "payout permit", { estimate })).hash;
    } else {
      admit();
    }
    const sent = await this.relayer.submit(transfer, "payout", { estimate: await this.relayer.estimate(transfer) });
    return { transaction: sent.hash, ...(permitted === undefined ? {} : { permit: permitted }), spender };
  }

  /** Mints `amount` of the Testnet token to `to`. The caller has checked the network has one. */
  async faucet(to: Address, token: Address, amount: bigint): Promise<FaucetResponse> {
    const call = { to: token, data: encodeFunctionData({ abi: stablecoinAbi, functionName: "mint", args: [to, amount] }) };
    const sent = await this.relayer.submit(call, "faucet");
    return { transaction: sent.hash, amount: amount.toString(), asset: token };
  }
}
