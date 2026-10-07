/**
 * Development-only stand-in for a passkey, so the whole flow can be driven in a browser that has
 * no authenticator (automated tests, a headless pane). It is compiled out of production builds:
 * `import.meta.env.DEV` is a constant Vite replaces, and every function refuses outside it.
 *
 * Enabled with `?devkey=1` once per browser; the fake PRF output is random and kept in local
 * storage, so the same "passkey" returns the same accounts until `?devkey=0`.
 */

import type { PrfResult } from "./ceremony";

const FLAG = "weir.devkey.enabled";
const SECRET = "weir.devkey.prf";

export function devKeysEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  const param = new URLSearchParams(window.location.search).get("devkey");
  try {
    if (param === "1") window.localStorage.setItem(FLAG, "1");
    if (param === "0") {
      window.localStorage.removeItem(FLAG);
      window.localStorage.removeItem(SECRET);
    }
    return window.localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

function secret(): Uint8Array {
  if (!import.meta.env.DEV) throw new Error("Development keys are not available in this build");
  let hex = window.localStorage.getItem(SECRET);
  if (hex === null) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    window.localStorage.setItem(SECRET, hex);
  }
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
}

export function devCreate(): PrfResult {
  return { credential: { credentialId: "development-key" }, prfOutput: secret() };
}

/** With a salt other than Mera's default, a different 32 bytes, as a real PRF would give. */
export async function devAssert(prfSalt?: Uint8Array): Promise<PrfResult> {
  const created = devCreate();
  if (prfSalt === undefined) return created;
  const joined = new Uint8Array([...created.prfOutput, ...prfSalt]);
  return { ...created, prfOutput: new Uint8Array(await crypto.subtle.digest("SHA-256", joined)) };
}
