import { describe, expect, it } from "vitest";

import {
  MANDATE_STATUSES,
  MissingEnvVarError,
  NETWORKS,
  formatDollars,
  mandateHubAbi,
  requireEnv,
  type MandateRecord,
} from "./index.js";

// The barrel re-exports several modules with `export *`. One symbol from each still arriving is
// what catches a name collision between them.
describe("package surface", () => {
  it("re-exports types, networks, money, config and the ABIs", () => {
    const status: MandateRecord["status"] = "Delinquent";
    expect(MANDATE_STATUSES).toContain(status);
    expect(NETWORKS[143].chain.id).toBe(143);
    expect(formatDollars(1_000_000n)).toBe("$1.00");
    expect(mandateHubAbi.length).toBeGreaterThan(0);
    expect(() => requireEnv("ABSENT_BY_CONSTRUCTION", {})).toThrow(MissingEnvVarError);
  });
});
