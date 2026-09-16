/**
 * Something that signs EIP-712 typed data as one address. In the CLI that is the Agent Wallet,
 * through the host's wallet executor and whatever policy and approvals the wallet enforces; in
 * tests and scripts it is a viem local account. Everything else in the plugin is the same for both.
 */

import type { Address, Hex, LocalAccount, TypedDataDefinition } from "viem";

export interface SignRequest {
  typedData: TypedDataDefinition;
  /** One line saying what the signature allows, which the wallet shows and records. */
  summary: string;
}

export interface Signer {
  readonly address: Address;
  signTypedData(request: SignRequest): Promise<Hex>;
}

/** A signer over a viem local account, for tests and scripts. */
export function localSigner(account: LocalAccount): Signer {
  return {
    address: account.address,
    signTypedData: ({ typedData }) => account.signTypedData(typedData),
  };
}
