import { describe, expect, it } from "vitest";

import { notesKeysFromPrfOutput, notesPrfSalt, openNotes, sealNotes, withNote } from "./keys";

const HUB = "0x184c6c26C1cB7f79885ED7c71e810E564CEec6a0";
const prf = (byte: number) => new Uint8Array(32).fill(byte);

/** Mera's default salt, the one the account keys come from. */
async function meraDefaultSalt(): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("mera.prf.salt.v1")));
}

describe("the notes namespace", () => {
  it("evaluates the passkey at a salt of its own, never the accounts' salt", async () => {
    const salt = await notesPrfSalt();
    expect(salt).toHaveLength(32);
    expect(salt).not.toEqual(await meraDefaultSalt());
  });

  it("seals and opens notes, and only the same passkey opens them", async () => {
    const mine = await notesKeysFromPrfOutput(prf(1), { chainId: 143, hub: HUB });
    const again = await notesKeysFromPrfOutput(prf(1), { chainId: 143, hub: HUB });
    const other = await notesKeysFromPrfOutput(prf(2), { chainId: 143, hub: HUB });
    const sealed = await sealNotes(mine.key, { "7": "Gym, cancel in March" });

    expect(sealed.ciphertext).not.toContain("Gym");
    expect(await openNotes(again.key, sealed)).toEqual({ "7": "Gym, cancel in March" });
    await expect(openNotes(other.key, sealed)).rejects.toThrow();
    expect(again.locker).toBe(mine.locker);
    expect(other.locker).not.toBe(mine.locker);
  });

  it("names a different locker on each network, and keeps the key out of reach", async () => {
    const mainnet = await notesKeysFromPrfOutput(prf(1), { chainId: 143, hub: HUB });
    const testnet = await notesKeysFromPrfOutput(prf(1), { chainId: 10143, hub: HUB });
    expect(mainnet.locker).toMatch(/^[0-9a-f]{64}$/);
    expect(testnet.locker).not.toBe(mainnet.locker);
    expect(mainnet.key.extractable).toBe(false);
  });

  it("zeroes the PRF output it was given", async () => {
    const output = prf(9);
    await notesKeysFromPrfOutput(output, { chainId: 143, hub: HUB });
    expect(output.every((byte) => byte === 0)).toBe(true);
  });

  it("adds, trims, caps and removes a note", () => {
    const one = withNote({}, "1", "  rent  ");
    expect(one).toEqual({ "1": "rent" });
    expect(withNote(one, "1", " ")).toEqual({});
    expect(withNote({}, "2", "x".repeat(300))["2"]).toHaveLength(200);
  });
});
