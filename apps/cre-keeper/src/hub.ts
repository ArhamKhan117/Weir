/**
 * Everything the workflow says to the chain, as bytes: the two Multicall3 reads and the report.
 *
 * The ABI fragments are written out here rather than imported from `@weir/shared`, because this
 * module is compiled into the WebAssembly workflow and the shared barrel carries the whole
 * generated ABI, the chain definitions and the Node-side config loader with it. `hub.test.ts`
 * pins every fragment against the ABIs generated from the Foundry build, so the two cannot drift.
 *
 * Every read is one Multicall3 `aggregate3` call with `allowFailure` false: none of the views can
 * revert for any id, so a failure means the read itself is broken, and a broken read must fail the
 * tick rather than look like one with nothing due.
 */

import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";

import type { Head, MandateState, MandateStatus } from "./tick.js";

/** Canonical on Monad Mainnet and Testnet alike. */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** The four hub views the workflow reads. */
export const hubAbi = parseAbi([
  "function nextMandateId() view returns (uint256)",
  "function isChargeable(uint256 mandateId) view returns (bool)",
  "function quoteCharge(uint256 mandateId) view returns (uint256 amount)",
  "struct Mandate { address payer; uint64 nextChargeAt; uint32 period; address merchant; uint64 expiresAt; uint8 status; address asset; uint96 amount; address manager; uint96 maxPerCharge; uint96 maxTotal; uint96 totalCharged; uint64 pausedAt; address vault; }",
  "function getMandate(uint256 mandateId) view returns (Mandate)",
]);

/** Multicall3's batch entry point and its own clock. */
export const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getBlockNumber() view returns (uint256 blockNumber)",
  "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
]);

/** `MandateCharger.onReport` decodes exactly this. */
export const REPORT_PARAMETERS = parseAbiParameters("uint256[] mandateIds");

const STATUSES: readonly MandateStatus[] = ["Active", "Delinquent", "Cancelled"];

interface Call3 {
  readonly target: Address;
  readonly allowFailure: boolean;
  readonly callData: Hex;
}

const call = (target: Address, callData: Hex): Call3 => ({ target, allowFailure: false, callData });

const aggregate3 = (calls: readonly Call3[]): Hex =>
  encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] });

/** The `returnData` of each call, refusing a failed one or a count that does not match. */
function unpack(data: Hex, expected: number): Hex[] {
  const results = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data });
  if (results.length !== expected) throw new Error(`aggregate3 returned ${results.length} results for ${expected} calls`);
  return results.map((result, index) => {
    if (!result.success) throw new Error(`call ${index} of the aggregate3 read failed`);
    return result.returnData;
  });
}

/*//////////////////////////////////////////////////////////////
                               HEAD
//////////////////////////////////////////////////////////////*/

/** Multicall3's block number and timestamp, and the hub's `nextMandateId`, in one call. */
export function encodeHeadRead(hub: Address): Hex {
  return aggregate3([
    call(MULTICALL3_ADDRESS, encodeFunctionData({ abi: multicall3Abi, functionName: "getBlockNumber" })),
    call(MULTICALL3_ADDRESS, encodeFunctionData({ abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" })),
    call(hub, encodeFunctionData({ abi: hubAbi, functionName: "nextMandateId" })),
  ]);
}

export function decodeHeadRead(data: Hex): Head {
  const [block, time, next] = unpack(data, 3) as [Hex, Hex, Hex];
  return {
    blockNumber: decodeFunctionResult({ abi: multicall3Abi, functionName: "getBlockNumber", data: block }),
    timestamp: decodeFunctionResult({ abi: multicall3Abi, functionName: "getCurrentBlockTimestamp", data: time }),
    nextMandateId: decodeFunctionResult({ abi: hubAbi, functionName: "nextMandateId", data: next }),
  };
}

/*//////////////////////////////////////////////////////////////
                               PAGE
//////////////////////////////////////////////////////////////*/

/** `getMandate`, `isChargeable` and `quoteCharge` for every id, in that order, in one call. */
export function encodePageRead(hub: Address, ids: readonly bigint[]): Hex {
  return aggregate3(
    ids.flatMap((id) => [
      call(hub, encodeFunctionData({ abi: hubAbi, functionName: "getMandate", args: [id] })),
      call(hub, encodeFunctionData({ abi: hubAbi, functionName: "isChargeable", args: [id] })),
      call(hub, encodeFunctionData({ abi: hubAbi, functionName: "quoteCharge", args: [id] })),
    ]),
  );
}

export function decodePageRead(ids: readonly bigint[], data: Hex): MandateState[] {
  const results = unpack(data, ids.length * 3);
  return ids.map((id, index): MandateState => {
    const [record, chargeable, quote] = results.slice(index * 3, index * 3 + 3) as [Hex, Hex, Hex];
    const m = decodeFunctionResult({ abi: hubAbi, functionName: "getMandate", data: record });
    const status = STATUSES[m.status];
    if (status === undefined) throw new Error(`mandate ${id} has status ${m.status}, which the hub cannot return`);
    return {
      id,
      payer: m.payer,
      status,
      period: m.period,
      nextChargeAt: m.nextChargeAt,
      expiresAt: m.expiresAt,
      amount: m.amount,
      maxPerCharge: m.maxPerCharge,
      maxTotal: m.maxTotal,
      totalCharged: m.totalCharged,
      pausedAt: m.pausedAt,
      chargeable: decodeFunctionResult({ abi: hubAbi, functionName: "isChargeable", data: chargeable }),
      quote: decodeFunctionResult({ abi: hubAbi, functionName: "quoteCharge", data: quote }),
    };
  });
}

/*//////////////////////////////////////////////////////////////
                              REPORT
//////////////////////////////////////////////////////////////*/

/** `abi.encode(uint256[] mandateIds)`, the report body `MandateCharger.onReport` decodes. */
export function encodeReport(ids: readonly bigint[]): Hex {
  return encodeAbiParameters(REPORT_PARAMETERS, [ids]);
}

export function decodeReport(data: Hex): readonly bigint[] {
  return decodeAbiParameters(REPORT_PARAMETERS, data)[0];
}
