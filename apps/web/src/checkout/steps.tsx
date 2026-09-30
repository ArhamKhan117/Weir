/**
 * The steps every way of saying yes shares: an account from a passkey, then money to pay with.
 *
 * A plan's checkout and a family support page both put these above their own last step, so a
 * person meets the same two screens whichever link brought them. Nothing here says wallet, gas,
 * chain or token.
 */

import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import { Alert, Button, CheckIcon, PasskeyIcon, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { balanceOf, vaultValue } from "../lib/chain";
import { canTopUp, IS_TESTNET } from "../lib/config";
import { money } from "../lib/format";
import { toast } from "../lib/toast";
import { useAccount } from "../passkey/AccountProvider";
import { passkeysAvailable } from "../passkey/ceremony";
import { AddMoneyButton } from "../topup/AddMoney";

/** How often a short balance is read again while the page waits for money to arrive. */
const FUNDS_REFRESH_MS = 6_000;

export function Step({
  n,
  title,
  done = false,
  locked = false,
  last = false,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  locked?: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="step" data-done={done} data-locked={locked} data-last={last}>
      <div className="step-head">
        <span className="step-n" aria-hidden="true">
          {done ? <CheckIcon size={14} /> : n}
        </span>
        <h2 className="step-title">{title}</h2>
      </div>
      <div className="step-body">{children}</div>
    </div>
  );
}

/** Step one: an account, created from a new passkey or found from an existing one. */
export function AccountStep({ n = 1, onError }: { n?: number; onError: (message: string | undefined) => void }) {
  const account = useAccount();
  const owner = account.account?.owner;

  async function createAccount() {
    onError(undefined);
    const result = await account.create(`Weir ${new Date().toLocaleDateString()}`);
    if (!result.ok && !result.cancelled) onError(result.message);
  }

  async function signIn() {
    onError(undefined);
    const result = await account.signIn();
    if (!result.ok && !result.cancelled) onError(result.message);
  }

  return (
    <Step n={n} title="Your account" done={owner !== undefined}>
      {owner === undefined ? (
        <>
          <p className="step-copy">Weir signs you in with a passkey: your face, fingerprint or device PIN. No password, no app to install.</p>
          {passkeysAvailable() ? (
            <div className="step-actions">
              <Button onClick={createAccount} loading={account.busy} size="lg" block>
                <PasskeyIcon /> Continue with a passkey
              </Button>
              <Button variant="ghost" onClick={signIn} disabled={account.busy} block>
                I already have a Weir passkey
              </Button>
            </div>
          ) : (
            <Alert tone="caution">This browser cannot use passkeys. Open this link in Safari, Chrome or Edge.</Alert>
          )}
        </>
      ) : (
        <div className="signed-in">
          <span className="signed-in-dot" aria-hidden="true">
            <CheckIcon size={14} />
          </span>
          <span>Signed in with your passkey{account.account?.dev ? " (development key)" : ""}</span>
        </div>
      )}
    </Step>
  );
}

export interface Funds {
  wallet: bigint;
  savings: bigint;
}

export interface FundsState {
  funds: Funds | undefined;
  /** What the chosen source holds: the balance, or savings. */
  available: bigint | undefined;
  /** The chosen source covers `needed`. */
  funded: boolean;
  useSavings: boolean;
  setUseSavings: (value: boolean) => void;
  refresh: () => Promise<void>;
}

/**
 * The payer's balance and savings in `asset`, read again every few seconds while they fall short
 * of `needed`: money can arrive from anywhere while the page is open, from a top-up settling or a
 * transfer from another wallet.
 */
export function useFunds(owner: Address | undefined, asset: Address, vault: Address | undefined, needed: bigint): FundsState {
  const [funds, setFunds] = useState<Funds | undefined>();
  const [useSavings, setUseSavings] = useState(false);

  const read = useCallback(
    async (payer: Address) => {
      const [wallet, savings] = await Promise.all([
        balanceOf(asset, payer),
        vault === undefined ? Promise.resolve(0n) : vaultValue(vault, payer),
      ]);
      setFunds({ wallet, savings });
    },
    [asset, vault],
  );

  useEffect(() => {
    if (owner === undefined) return;
    read(owner).catch(() => setFunds({ wallet: 0n, savings: 0n }));
  }, [owner, read]);

  const available = funds === undefined ? undefined : useSavings ? funds.savings : funds.wallet;
  const funded = available !== undefined && available >= needed;
  const short = available !== undefined && !funded;

  useEffect(() => {
    if (owner === undefined || !short) return;
    const timer = setInterval(() => void read(owner).catch(() => undefined), FUNDS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [owner, short, read]);

  const refresh = useCallback(async () => {
    if (owner !== undefined) await read(owner);
  }, [owner, read]);

  return { funds, available, funded, useSavings, setUseSavings, refresh };
}

/** Step two: where the money comes from, and a way to add some when there is not enough. */
export function FundsStep({
  n = 2,
  state,
  asset,
  assetSymbol,
  needed,
  neededFor,
  savingsVault,
  onError,
}: {
  n?: number;
  state: FundsState;
  asset: Address;
  assetSymbol: string;
  needed: bigint;
  /** What `needed` pays for, completing "You need $X for …": "the first charge". */
  neededFor: string;
  savingsVault?: { name: string; apyBps?: number } | undefined;
  onError: (message: string | undefined) => void;
}) {
  const account = useAccount();
  const owner = account.account?.owner;
  const [funding, setFunding] = useState(false);
  const { funds, available, funded, useSavings, setUseSavings, refresh } = state;

  async function addTestDollars() {
    if (owner === undefined) return;
    onError(undefined);
    setFunding(true);
    const id = toast.pending("Adding test dollars");
    try {
      const { transaction } = await api.faucet(owner);
      toast.success("Test dollars added", { replace: id, transaction });
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      toast.error("No test dollars this time", { replace: id, body: message });
      onError(message);
    } finally {
      setFunding(false);
    }
  }

  return (
    <Step n={n} title="Pay with" done={owner !== undefined && funded} locked={owner === undefined}>
      {owner === undefined ? (
        <p className="step-copy muted">Available once you are signed in.</p>
      ) : (
        <>
          <div className="balance-row">
            <div>
              <div className="balance-label">{useSavings ? "Savings" : "Balance"}</div>
              <div className="balance-value num">{available === undefined ? <Skeleton width={90} height={22} /> : money(available)}</div>
            </div>
            <span className="asset-chip">{assetSymbol}</span>
          </div>

          {savingsVault !== undefined && funds !== undefined && funds.savings > 0n ? (
            <label className="toggle step-gap" data-on={useSavings}>
              <input type="checkbox" checked={useSavings} onChange={(event) => setUseSavings(event.target.checked)} />
              <span className="toggle-text">
                <strong>Pay from savings</strong>
                <span>
                  Your money keeps earning
                  {savingsVault.apyBps === undefined ? "" : ` ${(savingsVault.apyBps / 100).toFixed(1)}% a year`} until the moment each
                  payment is due. If savings ever cannot pay, your balance does.
                </span>
              </span>
            </label>
          ) : null}

          {!funded && funds !== undefined ? (
            <div className="step-actions step-gap">
              <p className="step-copy">
                You need {money(needed)} for {neededFor}.
              </p>
              {IS_TESTNET ? (
                <Button variant="secondary" onClick={addTestDollars} loading={funding} block>
                  Add $100 in test dollars
                </Button>
              ) : null}
              {canTopUp(asset) ? (
                <AddMoneyButton recipient={owner} block onClosed={() => void refresh()}>
                  Add money from any chain
                </AddMoneyButton>
              ) : IS_TESTNET ? null : (
                <Alert>Add {assetSymbol} to your Weir account to continue.</Alert>
              )}
            </div>
          ) : null}
        </>
      )}
    </Step>
  );
}
