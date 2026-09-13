import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { linkedEvmWallets } from "./wallets.js";

const embedded = "0x00000000000000000000000000000000000000e1";
const external = "0x00000000000000000000000000000000000000e2";

describe("linkedEvmWallets", () => {
  it("keeps EVM wallets, embedded first, and leaves out everything else", () => {
    expect(
      linkedEvmWallets([
        { type: "email" },
        { type: "wallet", chainType: "ethereum", address: external, walletClientType: "metamask" },
        { type: "wallet", chainType: "solana", address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", walletClientType: "privy" },
        { type: "smart_wallet", address: "0x00000000000000000000000000000000000000e4" },
        { type: "wallet", chainType: "ethereum", address: embedded, walletClientType: "privy" },
        { type: "wallet", chainType: "ethereum", address: "not an address" },
        { type: "wallet", chainType: "ethereum", address: external.toUpperCase().replace("0X", "0x"), walletClientType: "rainbow" },
      ]),
    ).toEqual([getAddress(embedded), getAddress(external)]);
  });
});
