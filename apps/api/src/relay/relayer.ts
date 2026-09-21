/**
 * The relayer: the one path by which the relayer key signs anything.
 *
 * `submit` runs every call through the same steps, in this order:
 *
 * 1. **Policy.** {@link checkRelayCall} decodes the calldata and refuses anything off the allowlist.
 * 2. **Estimate.** Gas estimation executes the call, so it is also the simulation: a revert costs
 *    one RPC read and is answered 422 with the error's name, never paid for as a mined failure. A
 *    caller that has already estimated passes the figure in and it is not read again.
 * 3. **The queue.** One job at a time: state the limit from {@link gasLimitFor}, sign with the next
 *    nonce, and send, waiting for the receipt before the next job starts. On Monad the send and the
 *    receipt are one round trip (`eth_sendRawTransactionSync`), so holding the queue through the
 *    receipt costs well under a second and removes every nonce race, including the one after a
 *    dropped transaction.
 *
 * Every round trip counts: a person is watching a spinner. An install is one read-only call that
 * reports each part of the bundle, one estimate, and one synchronous send.
 *
 * The nonce is tracked locally after the first read and re-read from the chain after any failure,
 * so a node behind a load balancer answering with a stale count cannot make two jobs collide.
 */

import type { Address, Hex, Log } from "viem";

import type { Logger } from "../log.js";
import { messageOf } from "../log.js";
import { gasLimitFor } from "./gas.js";
import { decodeFunctionResult } from "viem";

import {
  aggregate3Abi,
  bundle,
  checkRelayCall,
  RelayPolicyError,
  type AllowedCall,
  type BundledCall,
  type RelayCall,
  type RelayPolicy,
} from "./policy.js";
import { SerialQueue } from "./queue.js";
import { decodeRevert, type DecodedRevert } from "./revert.js";

export interface RelayReceipt {
  status: "success" | "reverted";
  logs: readonly Log[];
  gasUsed: bigint;
}

/** What the relayer needs from the chain. Narrow, so tests drive it without a node. */
export interface RelayChain {
  readonly relayer: Address;
  /** `eth_call` from the relayer; returns the return data, throws on revert. */
  call(call: RelayCall): Promise<Hex>;
  estimateGas(call: RelayCall): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  /** The relayer's next nonce, counting pending transactions. */
  pendingNonce(): Promise<number>;
  /** Signs and broadcasts; returns the hash. */
  send(call: RelayCall & { gas: bigint; nonce: number }): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<RelayReceipt>;
  /**
   * Signs, broadcasts and returns the receipt in one round trip (EIP-7966,
   * `eth_sendRawTransactionSync`, which Monad serves). Optional: without it the relayer sends and
   * then polls for the receipt.
   */
  sendAndWait?(call: RelayCall & { gas: bigint; nonce: number }): Promise<{ hash: Hex; receipt: RelayReceipt }>;
}

/** The chain would refuse the call. Answered 422 `rejected_on_chain`. */
export class RejectedOnChainError extends Error {
  constructor(
    readonly revert: DecodedRevert,
    readonly transaction?: Hex,
  ) {
    super(transaction === undefined ? revert.detail : `${revert.detail} (transaction ${transaction})`);
    this.name = "RejectedOnChainError";
  }
}

/** Sent, but no receipt arrived in time. The hash is real and may still land. */
export class ReceiptTimeoutError extends Error {
  constructor(readonly transaction: Hex) {
    super(`transaction ${transaction} was sent and has no receipt yet`);
    this.name = "ReceiptTimeoutError";
  }
}

export interface Submitted {
  hash: Hex;
  receipt: RelayReceipt;
  gas: bigint;
  allowed: AllowedCall;
}

export class Relayer {
  readonly #queue = new SerialQueue();
  #nonce: number | undefined;

  constructor(
    private readonly chain: RelayChain,
    readonly policy: RelayPolicy,
    private readonly logger: Logger,
  ) {}

  get address(): Address {
    return this.chain.relayer;
  }

  get queueDepth(): number {
    return this.#queue.depth;
  }

  /** Resolves once every queued transaction has its receipt or has failed. */
  drain(): Promise<void> {
    return this.#queue.drain();
  }

  /**
   * Checks `call` against the policy and simulates it, without queueing or sending.
   *
   * @throws {RelayPolicyError} @throws {RejectedOnChainError}
   */
  async simulate(call: RelayCall): Promise<AllowedCall> {
    const allowed = checkRelayCall(this.policy, call);
    try {
      await this.chain.call(call);
    } catch (error) {
      const revert = decodeRevert(error);
      if (revert === undefined) throw error;
      throw new RejectedOnChainError(revert);
    }
    return allowed;
  }

  /**
   * What each call in a bundle would do, from one read-only call with every part allowed to fail,
   * so a failure comes back with its own revert data instead of Multicall3's generic one. Nothing
   * is signed, but every part is still held to the policy.
   *
   * @throws {RelayPolicyError}
   */
  async inspect(calls: readonly RelayCall[]): Promise<{ success: boolean; returnData?: Hex; revert?: DecodedRevert }[]> {
    const multicall = this.policy.multicall;
    if (multicall === undefined) throw new RelayPolicyError("the relayer has no Multicall3 to bundle through");
    for (const call of calls) checkRelayCall({ ...this.policy, multicall: undefined }, call);

    const probe = bundle(multicall, calls.map((call): BundledCall => ({ ...call, allowFailure: true })));
    const data = await this.chain.call(probe);
    const results = decodeFunctionResult({ abi: aggregate3Abi, functionName: "aggregate3", data });
    return results.map((result) =>
      result.success
        ? { success: true, returnData: result.returnData }
        : {
            success: false,
            revert: decodeRevert({ data: result.returnData }) ?? { name: "unknown", detail: "the call reverts without a reason" },
          },
    );
  }

  /**
   * Estimates `call` without queueing or sending. An estimate is a simulation: a call the chain
   * would refuse fails here with the same revert, so the caller learns it for free.
   *
   * @throws {RelayPolicyError} @throws {RejectedOnChainError}
   */
  async estimate(call: RelayCall): Promise<bigint> {
    checkRelayCall(this.policy, call);
    try {
      return await this.chain.estimateGas(call);
    } catch (error) {
      const revert = decodeRevert(error);
      if (revert === undefined) throw error;
      throw new RejectedOnChainError(revert);
    }
  }

  /**
   * Policy, then one queued send that waits for its receipt. The gas estimate doubles as the
   * simulation; a caller that has just estimated passes it in, and nothing is read twice.
   *
   * @throws {RelayPolicyError} @throws {RejectedOnChainError} @throws {ReceiptTimeoutError}
   */
  async submit(call: RelayCall, label: string, options: { estimate?: bigint } = {}): Promise<Submitted> {
    const allowed = checkRelayCall(this.policy, call);
    return this.#queue.run(async () => {
      const estimate = options.estimate ?? (await this.estimate(call));
      const gas = gasLimitFor(estimate);
      const nonce = this.#nonce ?? (await this.chain.pendingNonce());

      let hash: Hex;
      let receipt: RelayReceipt;
      if (this.chain.sendAndWait !== undefined) {
        try {
          ({ hash, receipt } = await this.chain.sendAndWait({ ...call, gas, nonce }));
        } catch (error) {
          // Whether it reached the chain is unknown: the next job re-reads the nonce.
          this.#nonce = undefined;
          throw error;
        }
        this.#nonce = nonce + 1;
      } else {
        try {
          hash = await this.chain.send({ ...call, gas, nonce });
        } catch (error) {
          this.#nonce = undefined;
          throw error;
        }
        this.#nonce = nonce + 1;
        try {
          receipt = await this.chain.waitForReceipt(hash);
        } catch (error) {
          // The transaction may yet land or be dropped; either way the next job re-reads the nonce.
          this.#nonce = undefined;
          this.logger.warn("relay receipt did not arrive", { label, transaction: hash, error: messageOf(error) });
          throw new ReceiptTimeoutError(hash);
        }
      }
      this.logger.info("relayed", { label, transaction: hash, status: receipt.status, gas });
      if (receipt.status !== "success") {
        throw new RejectedOnChainError({ name: "reverted", detail: "the transaction was mined and reverted" }, hash);
      }
      return { hash, receipt, gas, allowed };
    });
  }
}
