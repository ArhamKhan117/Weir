/**
 * Keep it earning: a payer's savings, beside their balance, with one-tap moves between the two.
 *
 * A payment set to pay from savings is charged straight from the vault, so money there earns until
 * the moment it is due. Moving money in or out is one passkey prompt and no gas: the owner key
 * signs a permit to the savings router and the relayer submits it. Nothing here can send money
 * anywhere but the payer's own account.
 */

import { parseDollars, UNIT, type SavingsResponse } from "@weir/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Address } from "viem";

import { Alert, Button, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { balanceOf, vaultValue } from "../lib/chain";
import { money } from "../lib/format";
import { moveToBalance, moveToSavings } from "../lib/savings";
import { withTransactionToast } from "../lib/toast";
import { useAccount } from "../passkey/AccountProvider";

const REFRESH_MS = 8_000;

type Vault = SavingsResponse["vaults"][number];

/** Base units as the plain decimal an amount field takes: no symbol, no separators. */
function amountText(units: bigint): string {
  const fraction = (units % UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? `${units / UNIT}` : `${units / UNIT}.${fraction}`;
}

export function SavingsSection({ owner, onMoved }: { owner: Address; onMoved: () => void }) {
  const [savings, setSavings] = useState<SavingsResponse | undefined>();

  useEffect(() => {
    api
      .savingsVaults()
      .then(setSavings)
      .catch(() => setSavings({ vaults: [] }));
  }, []);

  const router = savings?.router;
  if (savings === undefined || router === undefined || savings.vaults.length === 0) return null;

  return (
    <section className="section">
      <h2 className="section-title">Savings</h2>
      <div className="savings-list">
        {savings.vaults.map((vault) => (
          <SavingsCard key={vault.address} owner={owner} router={router} vault={vault} onMoved={onMoved} />
        ))}
      </div>
    </section>
  );
}

function SavingsCard({ owner, router, vault, onMoved }: { owner: Address; router: Address; vault: Vault; onMoved: () => void }) {
  const account = useAccount();
  const [funds, setFunds] = useState<{ wallet: bigint; saved: bigint } | undefined>();
  const [direction, setDirection] = useState<"in" | "out" | undefined>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    const [wallet, saved] = await Promise.all([balanceOf(vault.asset, owner), vaultValue(vault.address, owner)]);
    setFunds({ wallet, saved });
  }, [owner, vault.asset, vault.address]);

  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = setInterval(() => void refresh().catch(() => undefined), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const max = funds === undefined ? 0n : direction === "in" ? funds.wallet : funds.saved;
  let amount: bigint | undefined;
  try {
    amount = text.trim() === "" ? undefined : parseDollars(text);
  } catch {
    amount = undefined;
  }
  const valid = amount !== undefined && amount > 0n && amount <= max;

  function open(next: "in" | "out") {
    setDirection(next);
    setText("");
    setError(undefined);
    setDone(undefined);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (direction === undefined || amount === undefined || !valid) return;
    setBusy(true);
    setError(undefined);
    const moving = amount;
    const labels =
      direction === "in"
        ? { pending: `Moving ${money(moving)} into savings`, success: `${money(moving)} is in savings`, failure: "The move into savings did not go through" }
        : { pending: `Moving ${money(moving)} to your balance`, success: `${money(moving)} is back in your balance`, failure: "The move to your balance did not go through" };
    const result = await withTransactionToast(
      labels,
      () =>
        account.withOwner((signer) =>
          direction === "in"
            ? moveToSavings(signer, router, vault.asset, moving)
            : moveToBalance(signer, router, vault.asset, vault.address, moving),
        ),
      (transaction) => transaction,
    );
    setBusy(false);
    if (!result.ok) {
      if (!result.cancelled) setError(result.message);
      return;
    }
    setDone(direction === "in" ? `Moved ${money(moving)} into savings.` : `Moved ${money(moving)} to your balance.`);
    setDirection(undefined);
    await refresh().catch(() => undefined);
    onMoved();
  }

  const rate = vault.apyBps === undefined ? undefined : `${(vault.apyBps / 100).toFixed(1)}% a year`;

  return (
    <div className="card savings-card weir-gradient">
      <div className="savings-figures">
        <div>
          <div className="stat-label">In savings</div>
          <div className="savings-value num">{funds === undefined ? <Skeleton width={100} height={28} /> : money(funds.saved)}</div>
          <div className="savings-caption">
            {rate === undefined ? `Earning in ${vault.name}` : `Earning ${rate} in ${vault.name}`}
          </div>
        </div>
        <div>
          <div className="stat-label">In your balance</div>
          <div className="savings-value num">{funds === undefined ? <Skeleton width={100} height={28} /> : money(funds.wallet)}</div>
          <div className="savings-caption">{vault.assetSymbol}, ready to spend</div>
        </div>
      </div>

      <p className="savings-note">
        Payments set to pay from savings are charged straight from here, so your money earns until the moment each one is due.
      </p>

      {direction === undefined ? (
        <>
          {done !== undefined ? <Alert tone="positive">{done}</Alert> : null}
          <div className="savings-actions">
            <Button variant="secondary" onClick={() => open("in")} disabled={funds === undefined || funds.wallet === 0n}>
              Move to savings
            </Button>
            <Button variant="ghost" onClick={() => open("out")} disabled={funds === undefined || funds.saved === 0n}>
              Move to balance
            </Button>
          </div>
        </>
      ) : (
        <form className="savings-move" onSubmit={submit}>
          <label className="field">
            <span className="field-label">{direction === "in" ? "Move into savings" : "Move to your balance"}</span>
            <span className="input-affix">
              <span>$</span>
              <input
                className="input num"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={text}
                onChange={(event) => setText(event.target.value)}
                autoFocus
              />
            </span>
            <span className="field-hint">
              Up to {money(max)}.{" "}
              <button type="button" className="link" onClick={() => setText(amountText(max))}>
                Use all
              </button>
            </span>
          </label>
          {amount !== undefined && amount > max ? <Alert tone="caution">That is more than {money(max)}.</Alert> : null}
          {error !== undefined ? <Alert tone="negative">{error}</Alert> : null}
          <div className="form-actions">
            <Button type="button" variant="ghost" onClick={() => setDirection(undefined)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!valid}>
              {valid && amount !== undefined ? `Move ${money(amount)}` : "Move"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
