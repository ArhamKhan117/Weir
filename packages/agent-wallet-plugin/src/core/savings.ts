/**
 * Savings: dollars in a vault that earns until the moment a mandate paying from it is charged.
 *
 * Moving money in or out is one EIP-2612 permit to Weir's savings router, which the relayer
 * submits, so it takes no gas either. Into savings the permit is on the asset for the amount; out of
 * savings it is on the vault's shares for exactly what the withdrawal burns today. The router sends
 * everything back to the owner, so the permit cannot be put to any other use.
 */

import { API_ROUTES, explorerUrl, networkFor, permitTypedData, type MonadChainId, type SavingsRequest } from "@weir/shared";
import { isAddressEqual, type Address, type Hex } from "viem";

import type { Deps } from "./deps.js";
import { WeirError } from "./errors.js";
import { toJson, type Json } from "./json.js";
import { chainOf } from "./settings.js";
import type { SignRequest, Signer } from "./signer.js";
import { SIGNATURE_WINDOW } from "./terms.js";
import { money } from "./words.js";

export interface SavingsAccount {
  asset: Address;
  assetSymbol: string;
  vault: Address;
  name: string;
  symbol: string;
  apyBps?: number;
  /** Base units of the asset in the wallet. */
  balance: bigint;
  /** What the wallet's shares would pay out now, in base units of the asset. */
  saved: bigint;
}

export interface SavingsState {
  chainId: MonadChainId;
  owner: Address;
  router?: Address;
  accounts: SavingsAccount[];
}

/** The owner's balance and savings for every asset that has a savings vault. */
export async function readSavings(deps: Deps, owner: Address): Promise<SavingsState> {
  const [health, offered] = await Promise.all([deps.api.health(), deps.api.savingsVaults()]);
  const chainId = chainOf(health.chainId, deps.settings);
  const chain = deps.chain(chainId);
  const accounts = await Promise.all(
    offered.vaults.map(async (vault) => {
      const [balance, saved] = await Promise.all([chain.balanceOf(vault.asset, owner), chain.vaultValue(vault.address, owner)]);
      return {
        asset: vault.asset,
        assetSymbol: vault.assetSymbol,
        vault: vault.address,
        name: vault.name,
        symbol: vault.symbol,
        ...(vault.apyBps === undefined ? {} : { apyBps: vault.apyBps }),
        balance,
        saved,
      };
    }),
  );
  return { chainId, owner, ...(offered.router === undefined ? {} : { router: offered.router }), accounts };
}

export interface MoveInput {
  direction: "deposit" | "withdraw";
  /** Base units of the asset. */
  amount: bigint;
  /** Which asset's savings, by symbol or address; needed only when there is more than one. */
  asset?: string;
}

export interface MovePlan {
  direction: "deposit" | "withdraw";
  chainId: MonadChainId;
  owner: Address;
  router: Address;
  account: SavingsAccount;
  amount: bigint;
  /** Withdrawals: the shares the permit lets the router burn. */
  maxShares?: bigint;
  deadline: number;
  request: SignRequest;
}

/** Picks the savings account, checks the amount is there to move, and builds the permit. */
export async function prepareMove(deps: Deps, state: SavingsState, input: MoveInput): Promise<MovePlan> {
  const network = networkFor(state.chainId).label;
  if (state.router === undefined || state.accounts.length === 0) {
    throw new WeirError("NO_SAVINGS", `Weir offers no savings on ${network}`, "Nothing was signed.");
  }
  const router = state.router;
  const account = pickAccount(state.accounts, input.asset);
  const deposit = input.direction === "deposit";
  const available = deposit ? account.balance : account.saved;
  if (input.amount > available) {
    throw new WeirError(
      "INSUFFICIENT_FUNDS",
      deposit
        ? `Cannot move ${money(input.amount)} into savings: the wallet holds ${money(account.balance)} of ${account.assetSymbol}`
        : `Cannot move ${money(input.amount)} out of savings: they hold ${money(account.saved)} of ${account.assetSymbol}`,
      deposit
        ? state.chainId === 10143
          ? "Move less, or get test dollars with `mm weir faucet`."
          : "Move less."
        : "Move less.",
    );
  }

  const chain = deps.chain(state.chainId);
  const deadline = deps.now() + SIGNATURE_WINDOW;
  const token = deposit ? account.asset : account.vault;
  const [domain, nonce, maxShares] = await Promise.all([
    chain.permitDomain(token),
    chain.permitNonce(token, state.owner),
    deposit ? Promise.resolve(undefined) : chain.previewWithdraw(account.vault, input.amount),
  ]);
  const typedData = permitTypedData({
    token: { address: token, permit: domain },
    chainId: state.chainId,
    owner: state.owner,
    spender: router,
    value: maxShares ?? input.amount,
    nonce,
    deadline: BigInt(deadline),
  });
  const summary = deposit
    ? `Move ${money(input.amount)} of ${account.assetSymbol} into ${account.name}, through Weir's savings router`
    : `Move ${money(input.amount)} of ${account.assetSymbol} out of ${account.name} (at most ${maxShares} ${account.symbol} share units), through Weir's savings router`;

  return {
    direction: input.direction,
    chainId: state.chainId,
    owner: state.owner,
    router,
    account,
    amount: input.amount,
    ...(maxShares === undefined ? {} : { maxShares }),
    deadline,
    request: { typedData, summary },
  };
}

function pickAccount(accounts: SavingsAccount[], asset: string | undefined): SavingsAccount {
  if (asset === undefined) {
    const only = accounts[0];
    if (accounts.length === 1 && only !== undefined) return only;
    throw new WeirError(
      "INVALID_INPUT",
      `Weir offers savings in ${accounts.map((account) => account.assetSymbol).join(" and ")}; say which with --asset`,
      "For example --asset USDC.",
    );
  }
  const wanted = asset.trim().toLowerCase();
  const found = accounts.find((account) => account.assetSymbol.toLowerCase() === wanted || account.asset.toLowerCase() === wanted);
  if (found === undefined) {
    throw new WeirError(
      "INVALID_INPUT",
      `Weir offers no savings in ${asset}`,
      `Savings exist in ${accounts.map((account) => account.assetSymbol).join(", ")}.`,
    );
  }
  return found;
}

export function savingsRequest(plan: MovePlan, signature: Hex): SavingsRequest {
  return {
    direction: plan.direction,
    owner: plan.owner,
    asset: plan.account.asset,
    amount: plan.amount.toString(),
    ...(plan.maxShares === undefined ? {} : { maxShares: plan.maxShares.toString() }),
    deadline: plan.deadline,
    signature,
  };
}

export interface SavingsReport {
  chainId: MonadChainId;
  owner: Address;
  accounts: {
    asset: Address;
    assetSymbol: string;
    vault: Address;
    name: string;
    symbol: string;
    apyBps?: number;
    balance: string;
    saved: string;
  }[];
  /** Present when money was moved, or would be in a dry run. */
  move?: {
    dryRun: boolean;
    direction: "deposit" | "withdraw";
    assetSymbol: string;
    amount: string;
    maxShares?: string;
    signature?: { summary: string; typedData: Json };
    request?: { method: "POST"; url: string; body: Json };
    transaction?: Hex;
    explorerUrl?: string;
  };
}

export function savingsReport(state: SavingsState): SavingsReport {
  return {
    chainId: state.chainId,
    owner: state.owner,
    accounts: state.accounts.map((account) => ({
      asset: account.asset,
      assetSymbol: account.assetSymbol,
      vault: account.vault,
      name: account.name,
      symbol: account.symbol,
      ...(account.apyBps === undefined ? {} : { apyBps: account.apyBps }),
      balance: account.balance.toString(),
      saved: account.saved.toString(),
    })),
  };
}

function moveBase(plan: MovePlan, dryRun: boolean): NonNullable<SavingsReport["move"]> {
  return {
    dryRun,
    direction: plan.direction,
    assetSymbol: plan.account.assetSymbol,
    amount: plan.amount.toString(),
    ...(plan.maxShares === undefined ? {} : { maxShares: plan.maxShares.toString() }),
  };
}

export function moveDryRun(deps: Deps, state: SavingsState, plan: MovePlan): SavingsReport {
  return {
    ...savingsReport(state),
    move: {
      ...moveBase(plan, true),
      signature: { summary: plan.request.summary, typedData: toJson(plan.request.typedData) },
      request: {
        method: "POST",
        url: `${deps.api.baseUrl}${API_ROUTES.savings}`,
        body: toJson({ ...savingsRequest(plan, "0x"), signature: "<the wallet's permit signature>" }),
      },
    },
  };
}

/** Signs the permit with the wallet. */
export async function signMove(plan: MovePlan, signer: Signer): Promise<SavingsRequest> {
  if (!isAddressEqual(signer.address, plan.owner)) {
    throw new WeirError("SIGNING_FAILED", `The move was built for ${plan.owner} but the signer is ${signer.address}`, "Run the command again.");
  }
  return savingsRequest(plan, await signer.signTypedData(plan.request));
}

/** Has the relayer move the money, then reads the balances again. */
export async function relayMove(deps: Deps, plan: MovePlan, request: SavingsRequest): Promise<SavingsReport> {
  const { transaction } = await deps.api.savings(request);
  const after = await readSavings(deps, plan.owner);
  return {
    ...savingsReport(after),
    move: { ...moveBase(plan, false), transaction, explorerUrl: explorerUrl(plan.chainId, "tx", transaction) },
  };
}
