/**
 * One passkey, two keys: the derivation, and nothing that touches a browser.
 *
 * A passkey with the WebAuthn PRF extension returns 32 bytes that are a pure function of the
 * credential, the site and a fixed salt. Mera evaluates that PRF; this file turns the bytes into
 * accounts with the standard recipe, so the same passkey gives the same accounts anywhere:
 *
 *   PRF output (32 bytes) -> BIP-39 entropy -> BIP-39 seed -> BIP-32 root -> m/44'/60'/0'/0/<index>
 *
 * Index 0 is the **owner key**. It signs a mandate's terms and the permit for its asset, and it
 * exists only while a passkey prompt has just been answered. Index 1 is the **session key**. It
 * lives on this device, encrypted, and can pause, resume and cancel a mandate, which the hub
 * enforces: it can never create a mandate, raise a limit or change who gets paid.
 */

import { createSecp256k1SigningSession, getEvmAddress, type Secp256k1SigningSession } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
// Pinned to the 1.x line: 2.x ships sources without an `exports` map that bundlers resolve badly.
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { getAddress, type Address, type LocalAccount } from "viem";

export const OWNER_INDEX = 0;
export const SESSION_INDEX = 1;

const ROOT = "m/44'/60'/0'/0";

/** The BIP-39 seed for a PRF output. The PRF output is entropy, not the seed itself. */
export function seedFromPrfOutput(prfOutput: Uint8Array): Uint8Array {
  if (prfOutput.length !== 32) throw new RangeError(`A PRF output is 32 bytes, not ${prfOutput.length}`);
  return mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
}

/** The raw private key at an index, in a fresh buffer the caller must zero. */
export function privateKeyAt(seed: Uint8Array, index: number): Uint8Array {
  const root = HDKey.fromMasterSeed(seed);
  const node = root.derive(`${ROOT}/${index}`);
  try {
    if (node.privateKey === null) throw new Error(`Derivation at index ${index} produced no key`);
    return new Uint8Array(node.privateKey);
  } finally {
    node.wipePrivateData();
    root.wipePrivateData();
  }
}

/** A key that can sign, and the way to end it. The private key lives only inside the session. */
export interface SigningKey {
  readonly address: Address;
  readonly account: LocalAccount;
  end(): void;
}

/** A signing key from raw key bytes. The bytes are zeroed before this returns. */
export function signingKeyFrom(privateKey: Uint8Array): SigningKey {
  let session: Secp256k1SigningSession;
  try {
    session = createSecp256k1SigningSession({ privateKey });
  } finally {
    privateKey.fill(0);
  }
  return {
    address: getAddress(getEvmAddress(session.publicKey)),
    account: toViemAccount(session),
    end: () => session.end(),
  };
}

/** The owner and session keys for a PRF output. The PRF output and the seed are zeroed. */
export function keysFromPrfOutput(prfOutput: Uint8Array): {
  owner: SigningKey;
  sessionPrivateKey: Uint8Array;
  sessionAddress: Address;
} {
  const seed = seedFromPrfOutput(prfOutput);
  prfOutput.fill(0);
  try {
    const owner = signingKeyFrom(privateKeyAt(seed, OWNER_INDEX));
    const sessionPrivateKey = privateKeyAt(seed, SESSION_INDEX);
    const probe = signingKeyFrom(new Uint8Array(sessionPrivateKey));
    const sessionAddress = probe.address;
    probe.end();
    return { owner, sessionPrivateKey, sessionAddress };
  } finally {
    seed.fill(0);
  }
}
