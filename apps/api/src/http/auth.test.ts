import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { silentLogger } from "../log.js";
import { createMerchantAuth } from "./auth.js";

const embedded = "0x00000000000000000000000000000000000000e1";

describe("a Privy identity's wallets", () => {
  it("are read once a minute unless asked fresh, and a failed read is not kept", async () => {
    let calls = 0;
    let fail = false;
    const auth = createMerchantAuth({
      devAuth: false,
      logger: silentLogger,
      verifier: async () => "did:privy:user1",
      wallets: async () => {
        calls += 1;
        if (fail) throw new Error("down");
        return [getAddress(embedded)];
      },
    });
    const identity = await auth("Bearer token");
    await identity.wallets();
    await identity.wallets();
    expect(calls).toBe(1);
    await identity.wallets({ fresh: true });
    expect(calls).toBe(2);

    fail = true;
    await expect(identity.wallets({ fresh: true })).rejects.toThrow("down");
    fail = false;
    expect(await identity.wallets()).toEqual([getAddress(embedded)]);
    expect(calls).toBe(4);
  });
});
