import {
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  keccak256,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { describe, expect, it } from "vitest";
import { VAULT_ACCRUAL_GAS, mandateChargerAbi, mandateHubAbi } from "@weir/shared";
import {
  RETRYABLE_ERRORS,
  RetrySchedule,
  TERMINAL_ERRORS,
  accrualGasFor,
  chargeDue,
  classifyRevert,
  errorName,
  gasLimitFor,
  GasCeilingError,
  parseOutcomes,
  type ChargeOutcome,
  type ChargeReceipt,
  type ChargeTransport,
} from "./charge.js";
import { DEFAULT_GAS_POLICY, type GasPolicy } from "./config.js";

const HUB: Address = "0x1111111111111111111111111111111111111111";
const CHARGER: Address = "0x5555555555555555555555555555555555555555";
const TOKEN: Address = "0x4444444444444444444444444444444444444444";
const MERCHANT: Address = "0x3333333333333333333333333333333333333333";
const contracts = { hub: HUB, charger: CHARGER };

const selector = (signature: string): Hex => keccak256(stringToHex(signature)).slice(0, 10) as Hex;

function log(address: Address, topics: Hex[], data: Hex, logIndex: number): Log {
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockHash: `0x${"ab".repeat(32)}`,
    blockNumber: 100n,
    logIndex,
    transactionHash: `0x${"cd".repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  };
}

const charged = (id: bigint, amount: bigint, index: number, from: Address = HUB): Log =>
  log(
    from,
    encodeEventTopics({ abi: mandateHubAbi, eventName: "Charged", args: { mandateId: id, merchant: MERCHANT } }) as Hex[],
    encodeAbiParameters(
      getAbiItem({ abi: mandateHubAbi, name: "Charged" }).inputs.filter((input) => !input.indexed),
      [amount, amount, 1_800_000_060n],
    ),
    index,
  );

const failed = (id: bigint, reason: number, required: bigint, index: number): Log =>
  log(
    HUB,
    encodeEventTopics({ abi: mandateHubAbi, eventName: "ChargeFailed", args: { mandateId: id } }) as Hex[],
    encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [reason, required]),
    index,
  );

const reverted = (id: bigint, reason: Hex, index: number): Log =>
  log(
    CHARGER,
    encodeEventTopics({ abi: mandateChargerAbi, eventName: "ChargeReverted", args: { mandateId: id } }) as Hex[],
    encodeAbiParameters([{ type: "bytes4" }], [reason]),
    index,
  );

describe("gasLimitFor", () => {
  it("adds 5% rounded up and 5,000 gas", () => {
    expect(gasLimitFor(100_000n, DEFAULT_GAS_POLICY)).toBe(110_000n);
    expect(gasLimitFor(100_001n, DEFAULT_GAS_POLICY)).toBe(110_002n);
    expect(gasLimitFor(1_234_567n, DEFAULT_GAS_POLICY)).toBe(1_301_296n);
  });

  it("never goes below the floor", () => {
    expect(gasLimitFor(21_000n, DEFAULT_GAS_POLICY)).toBe(DEFAULT_GAS_POLICY.floor);
  });

  it("never goes above the ceiling, and refuses an estimate that is already above it", () => {
    expect(gasLimitFor(29_000_000n, DEFAULT_GAS_POLICY)).toBe(30_000_000n);
    expect(gasLimitFor(30_000_000n, DEFAULT_GAS_POLICY)).toBe(30_000_000n);
    expect(() => gasLimitFor(30_000_001n, DEFAULT_GAS_POLICY)).toThrow(GasCeilingError);
  });

  it("follows a configured policy", () => {
    const policy: GasPolicy = { marginBps: 1_000n, marginGas: 0n, floor: 21_000n, ceiling: 1_000_000n };
    expect(gasLimitFor(200_000n, policy)).toBe(220_000n);
  });
});

describe("revert classification", () => {
  it("names the hub's errors by selector", () => {
    expect(errorName(selector("NotDue(uint64,uint256)"))).toBe("NotDue");
    expect(errorName(selector("MandateIsCancelled()"))).toBe("MandateIsCancelled");
    expect(errorName(selector("TotalCapExceeded(uint96,uint96)"))).toBe("TotalCapExceeded");
    expect(errorName(selector("PaymentMismatch(uint256,uint256)"))).toBe("PaymentMismatch");
    expect(errorName("0x4e487b71")).toBe("Panic");
    expect(errorName("0x00000000")).toBeUndefined();
    expect(errorName("0xdeadbeef")).toBeUndefined();
  });

  it("treats as terminal only causes that can never stop being true", () => {
    for (const name of TERMINAL_ERRORS) expect(classifyRevert(name)).toBe("terminal");
    for (const name of RETRYABLE_ERRORS) expect(classifyRevert(name)).toBe("retryable");
    expect(classifyRevert(undefined)).toBe("retryable");
    expect(classifyRevert("Panic")).toBe("retryable");
  });

  it("classifies only errors the hub actually declares", () => {
    const declared = mandateHubAbi.flatMap((item) => (item.type === "error" ? [item.name] : []));
    expect(declared).toEqual(expect.arrayContaining([...TERMINAL_ERRORS, ...RETRYABLE_ERRORS]));
  });
});

describe("parseOutcomes", () => {
  it("reads one outcome per id from the receipt, in the order given", () => {
    const logs = [
      reverted(3n, selector("MandateExpired(uint64,uint256)"), 4),
      charged(1n, 5_000_000n, 1),
      failed(2n, 1, 5_000_000n, 2),
      reverted(4n, selector("NotDue(uint64,uint256)"), 3),
      reverted(5n, "0xdeadbeef", 5),
    ];
    expect(parseOutcomes([1n, 2n, 3n, 4n, 5n, 6n], logs, contracts)).toEqual<ChargeOutcome[]>([
      { id: 1n, kind: "charged", amount: 5_000_000n, nextChargeAt: 1_800_000_060n },
      { id: 2n, kind: "failed", reason: 1, required: 5_000_000n },
      { id: 3n, kind: "reverted", selector: selector("MandateExpired(uint64,uint256)"), error: "MandateExpired", disposition: "terminal" },
      { id: 4n, kind: "reverted", selector: selector("NotDue(uint64,uint256)"), error: "NotDue", disposition: "retryable" },
      { id: 5n, kind: "reverted", selector: "0xdeadbeef", error: undefined, disposition: "retryable" },
      { id: 6n, kind: "missing" },
    ]);
  });

  it("ignores look-alike events from any other contract", () => {
    const logs = [charged(1n, 5_000_000n, 0, TOKEN), charged(2n, 7n, 1, CHARGER)];
    expect(parseOutcomes([1n, 2n], logs, contracts)).toEqual([
      { id: 1n, kind: "missing" },
      { id: 2n, kind: "missing" },
    ]);
  });
});

/** A transport over a scripted chain that records every call and refuses overlapping sends. */
function fakeTransport(options: {
  estimate?: (ids: readonly bigint[]) => bigint;
  receipt?: (ids: readonly bigint[]) => Partial<ChargeReceipt>;
  failSendAt?: number;
}) {
  const calls: string[] = [];
  let inFlight = 0;
  let sends = 0;
  const pending = new Map<Hex, readonly bigint[]>();
  const transport: ChargeTransport = {
    estimate: async (ids) => {
      calls.push(`estimate ${ids.join(",")}`);
      return options.estimate?.(ids) ?? 60_000n * BigInt(ids.length);
    },
    send: async (ids, gas) => {
      calls.push(`send ${ids.join(",")} gas ${gas}`);
      sends += 1;
      if (sends === options.failSendAt) throw new Error("nonce too low");
      if (inFlight > 0) throw new Error("a second transaction was sent before the first was confirmed");
      inFlight += 1;
      const hash = `0x${sends.toString(16).padStart(64, "0")}` as Hex;
      pending.set(hash, ids);
      return hash;
    },
    wait: async (hash) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      const ids = pending.get(hash) ?? [];
      return {
        status: "success",
        logs: ids.map((id, index) => charged(id, 1_000n, index)),
        gasUsed: 0n,
        blockNumber: 100n,
        ...options.receipt?.(ids),
      };
    },
  };
  return { transport, calls };
}

describe("chargeDue", () => {
  it("sends batches of the configured size, one transaction at a time, with the padded limit", async () => {
    const { transport, calls } = fakeTransport({});
    const run = await chargeDue([1n, 2n, 3n, 4n, 5n], { transport, batchSize: 2, gas: DEFAULT_GAS_POLICY, contracts });
    expect(calls).toEqual([
      "estimate 1,2",
      "send 1,2 gas 131000",
      "estimate 3,4",
      "send 3,4 gas 131000",
      "estimate 5",
      "send 5 gas 68000",
    ]);
    expect(run.complete).toBe(true);
    expect(run.outcomes.map((outcome) => [outcome.id, outcome.kind])).toEqual([
      [1n, "charged"],
      [2n, "charged"],
      [3n, "charged"],
      [4n, "charged"],
      [5n, "charged"],
    ]);
    expect(run.batches.map((batch) => [batch.estimate, batch.gasLimit])).toEqual([
      [120_000n, 131_000n],
      [120_000n, 131_000n],
      [60_000n, 68_000n],
    ]);
  });

  it("allows each batch one interest accrual for every distinct savings vault it draws on", async () => {
    const { transport, calls } = fakeTransport({});
    const vaultA: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const vaultB: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const vaults = new Map<bigint, Address>([
      [1n, vaultA],
      [2n, vaultA],
      [3n, vaultB],
      [4n, zeroAddress],
    ]);
    expect(accrualGasFor([1n, 2n, 3n, 4n], vaults)).toBe(2n * VAULT_ACCRUAL_GAS);
    expect(accrualGasFor([4n, 5n], vaults)).toBe(0n);
    const run = await chargeDue([1n, 2n, 3n, 4n], { transport, batchSize: 4, gas: DEFAULT_GAS_POLICY, contracts, vaults });
    // 240,000 estimated plus 120,000 for two vaults, then the usual 5% and 5,000.
    expect(calls).toEqual(["estimate 1,2,3,4", "send 1,2,3,4 gas 383000"]);
    expect(run.batches[0]?.estimate).toBe(240_000n);
  });

  it("splits a batch whose estimate is above the ceiling", async () => {
    const { transport, calls } = fakeTransport({ estimate: (ids) => 12_000_000n * BigInt(ids.length) });
    const run = await chargeDue([1n, 2n, 3n, 4n], { transport, batchSize: 4, gas: DEFAULT_GAS_POLICY, contracts });
    expect(calls.filter((call) => call.startsWith("send"))).toEqual([
      "send 1,2 gas 25205000",
      "send 3,4 gas 25205000",
    ]);
    expect(run.complete).toBe(true);
  });

  it("stops at a failed send, and reports the run incomplete", async () => {
    const { transport, calls } = fakeTransport({ failSendAt: 2 });
    const run = await chargeDue([1n, 2n, 3n], { transport, batchSize: 1, gas: DEFAULT_GAS_POLICY, contracts });
    expect(calls.filter((call) => call.startsWith("send")).length).toBe(2);
    expect(run.complete).toBe(false);
    expect(run.outcomes.map((outcome) => outcome.id)).toEqual([1n]);
    expect(run.errors[0]).toMatch(/nonce too low/);
  });

  it("learns nothing about the mandates of a reverted transaction, and goes on", async () => {
    const { transport } = fakeTransport({ receipt: (ids) => (ids.includes(1n) ? { status: "reverted", logs: [] } : {}) });
    const run = await chargeDue([1n, 2n], { transport, batchSize: 1, gas: DEFAULT_GAS_POLICY, contracts });
    expect(run.complete).toBe(false);
    expect(run.outcomes.map((outcome) => outcome.id)).toEqual([2n]);
    expect(run.batches.map((batch) => batch.status)).toEqual(["reverted", "success"]);
  });
});

describe("RetrySchedule", () => {
  it("waits a minute after a failed charge, doubling to an hour, and forgets on success", () => {
    let now = 0;
    const retries = new RetrySchedule(() => now);
    const pastDue: ChargeOutcome = { id: 7n, kind: "failed", reason: 1, required: 1n };
    expect(retries.record(pastDue)).toBe(60_000);
    expect(retries.isWaiting(7n)).toBe(true);
    now = 60_000;
    expect(retries.isWaiting(7n)).toBe(false);
    expect(retries.record(pastDue)).toBe(120_000);
    for (let attempt = 0; attempt < 10; attempt += 1) retries.record(pastDue);
    expect(retries.record(pastDue)).toBe(3_600_000);
    expect(retries.record({ id: 7n, kind: "charged", amount: 1n, nextChargeAt: 1n })).toBeUndefined();
    expect(retries.isWaiting(7n)).toBe(false);
  });

  it("does not hold back a revert the next read explains", () => {
    const retries = new RetrySchedule(() => 0);
    const notDue: ChargeOutcome = { id: 1n, kind: "reverted", selector: "0x00000000", error: "NotDue", disposition: "retryable" };
    const unknown: ChargeOutcome = { id: 2n, kind: "reverted", selector: "0xdeadbeef", error: undefined, disposition: "retryable" };
    expect(retries.record(notDue)).toBeUndefined();
    expect(retries.record(unknown)).toBe(60_000);
    expect(retries.size).toBe(1);
  });
});
