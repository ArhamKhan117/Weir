/**
 * Which of a signed-in business's wallets can take its payouts. The API refuses a payout address
 * outside this list and the dashboard offers only what is in it, so both read it the same way.
 */

import { getAddress, isAddress, type Address } from "viem";

/** The fields of a Privy linked account this reads; both Privy SDKs' account types fit it. */
export interface LinkedAccountLike {
  type: string;
  address?: string;
  chainType?: string;
  walletClientType?: string;
}

/**
 * The EVM wallets among a Privy user's linked accounts, the embedded wallet first. Smart wallets
 * are left out: they are deployed per chain, and one not yet deployed on Monad cannot move what it
 * is paid.
 */
export function linkedEvmWallets(accounts: readonly LinkedAccountLike[]): Address[] {
  const embedded: Address[] = [];
  const external: Address[] = [];
  for (const account of accounts) {
    if (account.type !== "wallet" || account.chainType !== "ethereum") continue;
    if (account.address === undefined || !isAddress(account.address, { strict: false })) continue;
    const address = getAddress(account.address);
    const list = account.walletClientType === "privy" ? embedded : external;
    if (!list.includes(address)) list.push(address);
  }
  return [...embedded, ...external.filter((address) => !embedded.includes(address))];
}
