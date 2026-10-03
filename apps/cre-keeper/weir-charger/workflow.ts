/**
 * The CRE wiring: a cron trigger, EVM reads under the capability's consensus, and one signed
 * report written to `MandateCharger`. The decisions are in `../src/tick.ts`, the bytes in
 * `../src/hub.ts`; this file only turns SDK calls into the tick's three ports.
 *
 * Reads go through `EVMClient.callContract` from the DON-mode runtime, which is how the SDK means
 * chain state to be read: the capability runs the call on every node and returns only a result
 * the nodes agree on. Agreement needs every node to read the same state, so the head is read at
 * the last finalized block and every page is pinned to the block number that read returned, never
 * to "latest" and never to a later finalized block.
 *
 * The write is `runtime.report` (the DON signs `abi.encode(uint256[] ids)`) and then
 * `EVMClient.writeReport`, which hands the signed report to the network's forwarder; the
 * forwarder verifies the signatures and calls `MandateCharger.onReport`. The simulator writes
 * through the MockKeystoneForwarder instead, which the charger also accepts.
 */

import {
  blockNumber,
  bytesToHex,
  CronCapability,
  encodeCallMsg,
  EVMClient,
  getNetwork,
  handler,
  LAST_FINALIZED_BLOCK_NUMBER,
  prepareReportRequest,
  protoBigIntToBigint,
  TxStatus,
  type Runtime,
} from "@chainlink/cre-sdk";

import type { WorkflowConfig } from "../src/config.js";
import { decodeHeadRead, decodePageRead, encodeHeadRead, encodePageRead, encodeReport, MULTICALL3_ADDRESS } from "../src/hub.js";
import { runTick, type TickPorts, type TickSummary, type TxStatus as WriteTxStatus, type WriteOutcome } from "../src/tick.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** `ReceiverContractExecutionStatus` from the EVM capability, by value. */
const RECEIVER_SUCCESS = 0;

const TX_STATUSES: Readonly<Record<number, WriteTxStatus>> = {
  [TxStatus.SUCCESS]: "success",
  [TxStatus.REVERTED]: "reverted",
  [TxStatus.FATAL]: "fatal",
};

function evmClientFor(chainSelectorName: string): EVMClient {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName });
  if (network === undefined) throw new Error(`the SDK knows no EVM network named ${chainSelectorName}`);
  return new EVMClient(network.chainSelector.selector);
}

function portsFor(runtime: Runtime<WorkflowConfig>, evm: EVMClient): TickPorts {
  const { hub, charger } = runtime.config;
  const read = (data: `0x${string}`, at: typeof LAST_FINALIZED_BLOCK_NUMBER | ReturnType<typeof blockNumber>): `0x${string}` => {
    const reply = evm
      .callContract(runtime, { call: encodeCallMsg({ from: ZERO_ADDRESS, to: MULTICALL3_ADDRESS, data }), blockNumber: at })
      .result();
    return bytesToHex(reply.data);
  };

  return {
    readHead: () => decodeHeadRead(read(encodeHeadRead(hub), LAST_FINALIZED_BLOCK_NUMBER)),
    readPage: (ids, block) => decodePageRead(ids, read(encodePageRead(hub, ids), blockNumber(block))),
    writeReport: (ids, gasLimit): WriteOutcome => {
      const report = runtime.report(prepareReportRequest(encodeReport(ids))).result();
      const reply = evm.writeReport(runtime, { receiver: charger, report, gasConfig: { gasLimit: gasLimit.toString() } }).result();
      return {
        txStatus: TX_STATUSES[reply.txStatus] ?? "fatal",
        ...(reply.receiverContractExecutionStatus === undefined
          ? {}
          : { receiverStatus: reply.receiverContractExecutionStatus === RECEIVER_SUCCESS ? "success" : "reverted" }),
        ...(reply.txHash === undefined || reply.txHash.length === 0 ? {} : { txHash: bytesToHex(reply.txHash) }),
        ...(reply.transactionFee === undefined ? {} : { fee: protoBigIntToBigint(reply.transactionFee) }),
        ...(reply.errorMessage === undefined || reply.errorMessage === "" ? {} : { error: reply.errorMessage }),
      };
    },
  };
}

export const onCronTrigger = (runtime: Runtime<WorkflowConfig>): TickSummary => {
  const evm = evmClientFor(runtime.config.chainSelectorName);
  return runTick(runtime, runtime.config, portsFor(runtime, evm));
};

export const initWorkflow = (config: WorkflowConfig) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};
