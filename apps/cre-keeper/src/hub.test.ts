import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  getAbiItem,
  toEventSignature,
  toFunctionSelector,
  toFunctionSignature,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import { MULTICALL3_ADDRESS as SHARED_MULTICALL3, mandateChargerAbi, mandateHubAbi } from "@weir/shared";
import {
  MULTICALL3_ADDRESS,
  decodeHeadRead,
  decodePageRead,
  decodeReport,
  encodeHeadRead,
  encodePageRead,
  encodeReport,
  hubAbi,
  multicall3Abi,
} from "./hub.js";

const HUB: Address = "0x6CfD37e32c51d87c20362EeD0C6cc8908855045D";
const PAYER: Address = "0x2222222222222222222222222222222222222222";
const MERCHANT: Address = "0x3333333333333333333333333333333333333333";
const ASSET: Address = "0x4444444444444444444444444444444444444444";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** `getMandate`'s struct as viem encodes and decodes it. */
interface RawMandate {
  payer: Address;
  nextChargeAt: bigint;
  period: number;
  merchant: Address;
  expiresAt: bigint;
  status: number;
  asset: Address;
  amount: bigint;
  manager: Address;
  maxPerCharge: bigint;
  maxTotal: bigint;
  totalCharged: bigint;
  pausedAt: bigint;
  vault: Address;
}

/** A parameter's type with tuples spelled out, names ignored: what the bytes depend on. */
const canonical = (parameter: AbiParameter): string =>
  "components" in parameter && parameter.components !== undefined
    ? `(${parameter.components.map(canonical).join(",")})${parameter.type.slice("tuple".length)}`
    : parameter.type;

/** A multicall result as the chain would return it. */
const aggregate3Result = (returnData: Hex[], success = true): Hex =>
  encodeFunctionResult({
    abi: multicall3Abi,
    functionName: "aggregate3",
    result: returnData.map((data) => ({ success, returnData: data })),
  });

const record: RawMandate = {
  payer: PAYER,
  nextChargeAt: 1_800_000_000n,
  period: 60,
  merchant: MERCHANT,
  expiresAt: 1_900_000_000n,
  status: 1,
  asset: ASSET,
  amount: 5_000_000n,
  manager: ZERO,
  maxPerCharge: 5_000_000n,
  maxTotal: 30_000_000n,
  totalCharged: 10_000_000n,
  pausedAt: 0n,
  vault: ZERO,
};

/** The three results for one id, encoded with the ABI generated from the Foundry build. */
const resultsFor = (mandate: RawMandate, chargeable: boolean, quote: bigint): Hex[] => [
  encodeFunctionResult({ abi: mandateHubAbi, functionName: "getMandate", result: mandate }),
  encodeFunctionResult({ abi: mandateHubAbi, functionName: "isChargeable", result: chargeable }),
  encodeFunctionResult({ abi: mandateHubAbi, functionName: "quoteCharge", result: quote }),
];

describe("the ABI fragments", () => {
  it("match the hub's generated ABI in selector and in the shape of every output", () => {
    for (const item of hubAbi) {
      if (item.type !== "function") continue;
      const generated = getAbiItem({ abi: mandateHubAbi, name: item.name });
      expect(generated, item.name).toBeDefined();
      if (generated?.type !== "function") throw new Error(`${item.name} is not a function in the generated ABI`);
      expect(toFunctionSelector(toFunctionSignature(item)), item.name).toBe(toFunctionSelector(toFunctionSignature(generated)));
      expect(item.outputs.map(canonical), item.name).toEqual(generated.outputs.map(canonical));
      expect(item.stateMutability, item.name).toBe(generated.stateMutability);
    }
  });

  it("name the canonical Multicall3", () => {
    expect(MULTICALL3_ADDRESS).toBe(SHARED_MULTICALL3);
  });

  it("encode the report exactly as MandateCharger.onReport decodes it", () => {
    const onReport = getAbiItem({ abi: mandateChargerAbi, name: "onReport" });
    expect(toFunctionSignature(onReport)).toBe("onReport(bytes,bytes)");
    const reportCharged = getAbiItem({ abi: mandateChargerAbi, name: "ReportCharged" });
    expect(toEventSignature(reportCharged)).toBe("ReportCharged(bytes32,address,uint256,uint256)");

    const ids = [7n, 1n, 2n ** 200n];
    expect(encodeReport(ids)).toBe(encodeAbiParameters([{ type: "uint256[]" }], [ids]));
    expect(decodeReport(encodeReport(ids))).toEqual(ids);
    // The head word is the offset of the dynamic array, then its length, then the elements.
    expect(encodeReport([1n, 2n])).toBe(
      `0x${[0x20, 2, 1, 2].map((word) => word.toString(16).padStart(64, "0")).join("")}`,
    );
  });
});

describe("the head read", () => {
  it("asks Multicall3 for its block and time and the hub for its next id, in one call", () => {
    const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data: encodeHeadRead(HUB) });
    expect(functionName).toBe("aggregate3");
    const calls = args[0] as ReadonlyArray<{ target: string; allowFailure: boolean; callData: Hex }>;
    expect(calls.map((call) => call.target)).toEqual([MULTICALL3_ADDRESS, MULTICALL3_ADDRESS, HUB]);
    expect(calls.every((call) => !call.allowFailure)).toBe(true);
    expect(decodeFunctionData({ abi: multicall3Abi, data: calls[0]!.callData }).functionName).toBe("getBlockNumber");
    expect(decodeFunctionData({ abi: multicall3Abi, data: calls[1]!.callData }).functionName).toBe("getCurrentBlockTimestamp");
    expect(decodeFunctionData({ abi: mandateHubAbi, data: calls[2]!.callData }).functionName).toBe("nextMandateId");
  });

  it("decodes the three answers", () => {
    const data = aggregate3Result([
      encodeFunctionResult({ abi: multicall3Abi, functionName: "getBlockNumber", result: 65_595_970n }),
      encodeFunctionResult({ abi: multicall3Abi, functionName: "getCurrentBlockTimestamp", result: 1_790_346_595n }),
      encodeFunctionResult({ abi: mandateHubAbi, functionName: "nextMandateId", result: 6n }),
    ]);
    expect(decodeHeadRead(data)).toEqual({ blockNumber: 65_595_970n, timestamp: 1_790_346_595n, nextMandateId: 6n });
  });
});

describe("the page read", () => {
  it("asks for getMandate, isChargeable and quoteCharge per id, in order, none allowed to fail", () => {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data: encodePageRead(HUB, [4n, 9n]) });
    const calls = args[0] as ReadonlyArray<{ target: string; allowFailure: boolean; callData: Hex }>;
    expect(calls.every((call) => call.target === HUB && !call.allowFailure)).toBe(true);
    expect(calls.map((call) => decodeFunctionData({ abi: mandateHubAbi, data: call.callData }))).toEqual([
      { functionName: "getMandate", args: [4n] },
      { functionName: "isChargeable", args: [4n] },
      { functionName: "quoteCharge", args: [4n] },
      { functionName: "getMandate", args: [9n] },
      { functionName: "isChargeable", args: [9n] },
      { functionName: "quoteCharge", args: [9n] },
    ]);
  });

  it("decodes results encoded with the generated ABI into mandate states", () => {
    const unknown = { ...record, payer: ZERO, status: 0, period: 0, amount: 0n, maxPerCharge: 0n, maxTotal: 0n, totalCharged: 0n };
    const data = aggregate3Result([...resultsFor(record, true, 5_000_000n), ...resultsFor(unknown, false, 0n)]);
    expect(decodePageRead([4n, 9n], data)).toEqual([
      {
        id: 4n,
        payer: PAYER,
        status: "Delinquent",
        period: 60,
        nextChargeAt: 1_800_000_000n,
        expiresAt: 1_900_000_000n,
        amount: 5_000_000n,
        maxPerCharge: 5_000_000n,
        maxTotal: 30_000_000n,
        totalCharged: 10_000_000n,
        pausedAt: 0n,
        chargeable: true,
        quote: 5_000_000n,
      },
      expect.objectContaining({ id: 9n, payer: ZERO, status: "Active", chargeable: false, quote: 0n }),
    ]);
  });

  it("refuses a failed call, a short answer and a status the hub cannot return", () => {
    const one = resultsFor(record, true, 5_000_000n);
    expect(() => decodePageRead([4n], aggregate3Result(one, false))).toThrow("call 0 of the aggregate3 read failed");
    expect(() => decodePageRead([4n, 5n], aggregate3Result(one))).toThrow("aggregate3 returned 3 results for 6 calls");
    const bad = aggregate3Result(resultsFor({ ...record, status: 3 }, true, 1n));
    expect(() => decodePageRead([4n], bad)).toThrow("mandate 4 has status 3");
  });
});
