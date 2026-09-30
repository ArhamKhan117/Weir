/**
 * Moving a payer's dollars into their savings vault and back out, with no gas: the owner key signs
 * an EIP-2612 permit to the savings router, and the relayer submits the router call. Into savings,
 * the permit is on the asset for the amount; out, it is on the vault's shares for exactly what the
 * withdrawal burns. The router sends everything to the owner, so the permit cannot be put to any
 * other use.
 */

import { permitTypedData } from "@weir/shared";
import { type Address, type Hex, type LocalAccount } from "viem";

import { api } from "./api";
import { client, permitNonce, vaultAbi } from "./chain";
import { CHAIN_ID } from "./config";
import { SIGNATURE_WINDOW } from "./mandate";
import { permitDomainFor } from "./permit";

async function signPermit(owner: LocalAccount, token: Address, router: Address, value: bigint, deadline: number): Promise<Hex> {
  const [domain, nonce] = await Promise.all([permitDomainFor(token), permitNonce(token, owner.address)]);
  return owner.signTypedData(
    permitTypedData({
      token: { address: token, permit: domain },
      chainId: CHAIN_ID,
      owner: owner.address,
      spender: router,
      value,
      nonce,
      deadline: BigInt(deadline),
    }),
  );
}

/** Moves `amount` of `asset` from the owner's balance into their savings. */
export async function moveToSavings(owner: LocalAccount, router: Address, asset: Address, amount: bigint): Promise<Hex> {
  const deadline = Math.floor(Date.now() / 1000) + SIGNATURE_WINDOW;
  const signature = await signPermit(owner, asset, router, amount, deadline);
  const response = await api.savings({ direction: "deposit", owner: owner.address, asset, amount: amount.toString(), deadline, signature });
  return response.transaction;
}

/** Moves `amount` of `asset` from the owner's savings in `vault` back to their balance. */
export async function moveToBalance(
  owner: LocalAccount,
  router: Address,
  asset: Address,
  vault: Address,
  amount: bigint,
): Promise<Hex> {
  const deadline = Math.floor(Date.now() / 1000) + SIGNATURE_WINDOW;
  const maxShares = await client.readContract({ address: vault, abi: vaultAbi, functionName: "previewWithdraw", args: [amount] });
  const signature = await signPermit(owner, vault, router, maxShares, deadline);
  const response = await api.savings({
    direction: "withdraw",
    owner: owner.address,
    asset,
    amount: amount.toString(),
    maxShares: maxShares.toString(),
    deadline,
    signature,
  });
  return response.transaction;
}
