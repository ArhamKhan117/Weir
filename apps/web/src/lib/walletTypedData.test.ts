import { hashTypedData, recoverTypedDataAddress, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { walletTypedData } from "./walletTypedData";

const permit: TypedDataDefinition = {
  domain: { name: "USDC", version: "2", chainId: 143, verifyingContract: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" },
  types: {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Permit",
  message: {
    owner: "0x6b41bdbee4a774161c46993634a0ab8f11ae8087",
    spender: "0x00ecDB244F5cA2fd2a9f3d78147c309c5Fa0B36B",
    value: 251494n,
    nonce: 0n,
    deadline: 1791336889n,
  },
};

describe("walletTypedData", () => {
  it("declares the domain's type, so a wallet hashes the real domain", () => {
    const payload = JSON.parse(walletTypedData(permit));
    expect(payload.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]);
    expect(payload.domain.name).toBe("USDC");
  });

  it("is the same message the contract checks", async () => {
    const payload = JSON.parse(walletTypedData(permit));
    expect(hashTypedData(payload)).toBe(hashTypedData(permit));
    const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const signature = await account.signTypedData(payload);
    expect(await recoverTypedDataAddress({ ...permit, signature })).toBe(account.address);
  });
});
