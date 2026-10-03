import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MONAD_MAINNET_CHAIN_ID, MONAD_TESTNET_CHAIN_ID, NETWORKS, deploymentFor } from "@weir/shared";
import { DEFAULTS, MAX_PAGE_SIZE, configSchema, parseConfig, scheduleIntervalSeconds, type ConfigResult } from "./config.js";
import { MAX_BATCH_LIMIT } from "./tick.js";

/** A config file as the SDK hands it to the schema: `JSON.parse` of the bytes. */
const configFile = (name: string): unknown => JSON.parse(readFileSync(new URL(`../weir-charger/${name}`, import.meta.url), "utf8"));

const valid = {
  chainSelectorName: "monad-testnet",
  hub: "0x6CfD37e32c51d87c20362EeD0C6cc8908855045D",
  charger: "0xdEc2AaCCbCb29Aea8a2F1FA1fdDb9628Ca9C4B2c",
};

const value = (result: ConfigResult) => {
  if (!("value" in result)) throw new Error(`expected a valid config, got ${JSON.stringify(result.issues)}`);
  return result.value;
};
const messages = (result: ConfigResult): string[] => ("issues" in result ? result.issues.map((issue) => issue.message) : []);

describe("the shipped configs", () => {
  it("point staging at the Testnet deployment record, every 30 seconds", () => {
    const deployment = deploymentFor(MONAD_TESTNET_CHAIN_ID);
    if (deployment === undefined) throw new Error("deployments.json has no Testnet entry");
    const config = value(parseConfig(configFile("config.json")));
    expect(config.hub).toBe(deployment.contracts.MandateHub);
    expect(config.charger).toBe(deployment.contracts.MandateCharger);
    expect(config.chainSelectorName).toBe(NETWORKS[MONAD_TESTNET_CHAIN_ID].cre.chainSelectorName);
    expect(config.intervalSeconds).toBe(30);
    expect(config).toMatchObject({ pageSize: 200, maxBatch: 50, policy: { streamMinCharge: 10_000n, streamMaxAgeSeconds: 3_600n } });
  });

  it("point production at Mainnet every 5 minutes, and refuse to run until Mainnet is in the record", () => {
    const raw = configFile("config.production.json") as Record<string, unknown>;
    expect(raw.chainSelectorName).toBe(NETWORKS[MONAD_MAINNET_CHAIN_ID].cre.chainSelectorName);
    expect(scheduleIntervalSeconds(String(raw.schedule))).toBe(300);

    const deployment = deploymentFor(MONAD_MAINNET_CHAIN_ID);
    if (deployment === undefined) {
      expect(messages(parseConfig(raw))).toEqual([
        "hub is the zero address; fill it in from the deployment record",
        "charger is the zero address; fill it in from the deployment record",
      ]);
    } else {
      const config = value(parseConfig(raw));
      expect(config.hub).toBe(deployment.contracts.MandateHub);
      expect(config.charger).toBe(deployment.contracts.MandateCharger);
    }
  });
});

describe("parseConfig", () => {
  it("fills the defaults: every 5 minutes, pages of 200, batches of 50, a 10,000 base unit stream minimum", () => {
    const config = value(parseConfig(valid));
    expect(config.schedule).toBe(DEFAULTS.schedule);
    expect(config.intervalSeconds).toBe(300);
    expect(config.pageSize).toBe(200);
    expect(config.maxBatch).toBe(50);
    expect(config.policy).toEqual({ streamMinCharge: 10_000n, streamMaxAgeSeconds: 3_600n, intervalSeconds: 300n });
  });

  it("takes amounts as numbers or decimal strings", () => {
    expect(value(parseConfig({ ...valid, streamMinCharge: 25 })).policy.streamMinCharge).toBe(25n);
    expect(value(parseConfig({ ...valid, streamMinCharge: "79228162514264337593543950335" })).policy.streamMinCharge).toBe(2n ** 96n - 1n);
    expect(messages(parseConfig({ ...valid, streamMinCharge: -1 }))).toEqual([
      "streamMinCharge must be a non-negative integer, as a number or a decimal string",
    ]);
    expect(messages(parseConfig({ ...valid, streamMaxAgeSeconds: "1e3" }))).toHaveLength(1);
  });

  it("refuses addresses that are malformed or zero, and a chain it does not know", () => {
    expect(messages(parseConfig({ ...valid, hub: "0x1234", chainSelectorName: "ethereum-mainnet" }))).toEqual([
      "chainSelectorName must be one of monad-testnet, monad-mainnet",
      "hub must be a 0x-prefixed 20-byte address",
    ]);
    expect(messages(parseConfig({ ...valid, charger: `0x${"0".repeat(40)}` }))).toEqual([
      "charger is the zero address; fill it in from the deployment record",
    ]);
  });

  it("bounds the page size and the batch, the batch by what CRE's gas ceiling can carry", () => {
    expect(value(parseConfig({ ...valid, pageSize: MAX_PAGE_SIZE, maxBatch: MAX_BATCH_LIMIT })).maxBatch).toBe(MAX_BATCH_LIMIT);
    expect(messages(parseConfig({ ...valid, pageSize: 0 }))).toEqual([`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`]);
    expect(messages(parseConfig({ ...valid, maxBatch: MAX_BATCH_LIMIT + 1 }))).toEqual([`maxBatch must be an integer from 1 to ${MAX_BATCH_LIMIT}`]);
    // A bigger allowance per mandate leaves room for fewer of them.
    expect(messages(parseConfig({ ...valid, gasPerMandate: 500_000, maxBatch: 20 }))).toEqual(["maxBatch must be an integer from 1 to 19"]);
    expect(value(parseConfig({ ...valid, gasPerMandate: "500000", maxBatch: 19 })).gasPerMandate).toBe(500_000n);
    expect(messages(parseConfig({ ...valid, gasPerMandate: 1_000 }))).toEqual(["gasPerMandate must be from 50000 to 9800000"]);
    expect(messages(parseConfig({ ...valid, maxBatch: 2.5 }))).toHaveLength(1);
  });

  it("refuses a schedule faster than CRE allows or without a steady interval", () => {
    expect(messages(parseConfig({ ...valid, schedule: "*/10 * * * * *" }))).toEqual([
      `schedule "*/10 * * * * *" fires every 10s; CRE's fastest cron is every 30s`,
    ]);
    expect(messages(parseConfig({ ...valid, schedule: "0 0 9 * * 1-5" }))).toEqual([
      `schedule "0 0 9 * * 1-5" does not fire at a steady interval; use every N seconds, minutes or hours`,
    ]);
  });

  it("refuses keys it does not read, so a misspelt setting is not silently defaulted", () => {
    expect(messages(parseConfig({ ...valid, maxBatchSize: 10 }))).toEqual(["maxBatchSize is not a setting this workflow reads"]);
    expect(messages(parseConfig([]))).toEqual(["the config must be a JSON object"]);
  });

  it("answers through the Standard Schema interface the SDK validates with", () => {
    const standard = configSchema["~standard"];
    expect(standard.version).toBe(1);
    expect("value" in standard.validate(valid)).toBe(true);
    expect(standard.validate({})).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: ["hub"] })]) });
  });
});

describe("scheduleIntervalSeconds", () => {
  it.each([
    ["*/30 * * * * *", 30],
    ["0/30 * * * * *", 30],
    ["0 */5 * * * *", 300],
    ["*/5 * * * *", 300],
    ["15 * * * * *", 60],
    ["0 0 * * * *", 3_600],
    ["0 0 */6 * * *", 21_600],
    ["0 30 9 * * *", 86_400],
    ["0 0 0 ? * *", 86_400],
    ["* * * * * *", 1],
  ])("%s fires every %i seconds", (schedule, seconds) => {
    expect(scheduleIntervalSeconds(schedule)).toBe(seconds);
  });

  it.each([
    "*/7 * * * * *",
    "0 */5 9 * * *",
    "0 0 9 * * 1-5",
    "0 0 9 1 * *",
    "0 60 * * * *",
    "0 1,31 * * * *",
    "@hourly",
    "",
  ])("%s has no steady interval", (schedule) => {
    expect(scheduleIntervalSeconds(schedule)).toBeUndefined();
  });
});
