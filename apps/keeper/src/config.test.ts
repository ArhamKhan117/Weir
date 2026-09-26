import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InvalidEnvVarError, MissingEnvVarError, requireDeployment } from "@weir/shared";
import { DEFAULT_GAS_POLICY, loadKeeperConfig, resolveStatePath } from "./config.js";
import { parseArgs } from "./index.js";

/** A throwaway key, well known and holding nothing: the first anvil development account's. */
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const minimal = { MONAD_CHAIN_ID: "10143", KEEPER_PRIVATE_KEY: KEY };

describe("loadKeeperConfig", () => {
  it("takes the deployment from the record and defaults every knob", () => {
    const config = loadKeeperConfig(minimal, join(ROOT, "apps", "keeper"));
    expect(config.network).toEqual({ chainId: 10143, rpcUrl: "https://testnet-rpc.monad.xyz" });
    expect(config.deployment.contracts.MandateHub).toBe(requireDeployment(10143).contracts.MandateHub);
    expect(config.logChunkBlocks).toBe(100);
    expect(config.hypersync).toBeUndefined();
    expect(config).toMatchObject({
      intervalMs: 5_000,
      batchSize: 50,
      streamMinCharge: 10_000n,
      streamMaxAgeSeconds: 3_600n,
      host: "127.0.0.1",
      port: 8_791,
      gas: DEFAULT_GAS_POLICY,
    });
    // Relative to the workspace root wherever the keeper is started from, so there is one cursor.
    expect(config.cursorPath).toBe(join(ROOT, ".state", "keeper-cursor.json"));
    expect(loadKeeperConfig(minimal, ROOT).cursorPath).toBe(config.cursorPath);
  });

  it("reads every knob", () => {
    const config = loadKeeperConfig({
      ...minimal,
      KEEPER_INTERVAL_MS: "2000",
      KEEPER_BATCH_SIZE: "10",
      KEEPER_STREAM_MIN_CHARGE: "250000",
      KEEPER_STREAM_MAX_AGE_SECONDS: "600",
      KEEPER_CURSOR_PATH: "/var/lib/weir/cursor.json",
      KEEPER_HOST: "0.0.0.0",
      KEEPER_PORT: "9000",
      KEEPER_GAS_MARGIN_BPS: "1000",
      KEEPER_GAS_MARGIN_GAS: "0",
      KEEPER_GAS_FLOOR: "21000",
      KEEPER_GAS_CEILING: "5000000",
      HYPERSYNC_URL: "https://monad-testnet.hypersync.xyz",
      HYPERSYNC_API_TOKEN: "token",
    });
    expect(config).toMatchObject({
      intervalMs: 2_000,
      batchSize: 10,
      streamMinCharge: 250_000n,
      streamMaxAgeSeconds: 600n,
      cursorPath: "/var/lib/weir/cursor.json",
      host: "0.0.0.0",
      port: 9_000,
      gas: { marginBps: 1_000n, marginGas: 0n, floor: 21_000n, ceiling: 5_000_000n },
    });
    expect(config.hypersync?.url).toBe("https://monad-testnet.hypersync.xyz");
    expect(String(config.hypersync?.token)).toBe("[redacted HYPERSYNC_API_TOKEN]");
  });

  it("uses HyperSync only when both of its variables are set", () => {
    expect(loadKeeperConfig({ ...minimal, HYPERSYNC_URL: "https://monad-testnet.hypersync.xyz" }).hypersync).toBeUndefined();
    expect(loadKeeperConfig({ ...minimal, HYPERSYNC_API_TOKEN: "token" }).hypersync).toBeUndefined();
  });

  it("names what is missing or malformed, and never echoes the key", () => {
    expect(() => loadKeeperConfig({ MONAD_CHAIN_ID: "10143" })).toThrow(MissingEnvVarError);
    expect(() => loadKeeperConfig({ ...minimal, KEEPER_BATCH_SIZE: "0" })).toThrow(InvalidEnvVarError);
    expect(() => loadKeeperConfig({ ...minimal, KEEPER_STREAM_MIN_CHARGE: "-1" })).toThrow(InvalidEnvVarError);
    expect(() => loadKeeperConfig({ ...minimal, KEEPER_GAS_CEILING: "30000001" })).toThrow(InvalidEnvVarError);
    expect(() => loadKeeperConfig({ ...minimal, KEEPER_GAS_FLOOR: "90000", KEEPER_GAS_CEILING: "80000" })).toThrow(/KEEPER_GAS_FLOOR/);

    const badKey = `${KEY.slice(0, -2)}zz`;
    let message = "";
    try {
      loadKeeperConfig({ ...minimal, KEEPER_PRIVATE_KEY: badKey });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/KEEPER_PRIVATE_KEY must be 32 bytes/);
    expect(message).not.toContain(badKey.slice(2, 20));
  });
});

describe("resolveStatePath", () => {
  it("keeps an absolute path and resolves a relative one outside a workspace against the directory given", () => {
    expect(resolveStatePath("/tmp/cursor.json", ROOT)).toBe("/tmp/cursor.json");
    expect(resolveStatePath("state/cursor.json", "/")).toBe("/state/cursor.json");
  });
});

describe("parseArgs", () => {
  it("accepts --once and --help and refuses anything else", () => {
    expect(parseArgs([])).toEqual({ once: false, help: false });
    expect(parseArgs(["--once"])).toEqual({ once: true, help: false });
    expect(parseArgs(["--help"])).toEqual({ once: false, help: true });
    expect(parseArgs(["--twice"])).toBe("unknown argument --twice");
  });
});
