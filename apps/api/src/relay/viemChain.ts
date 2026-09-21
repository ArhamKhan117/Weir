/**
 * {@link RelayChain} over viem: a public client for reads and a wallet client holding the relayer
 * account. The account is built by the caller from the `Secret`, so this module never sees a key.
 */

import { monadTransport, stablecoinAbi } from "@weir/shared";
import {
  createWalletClient,
  type Chain,
  type LocalAccount,
  type PublicClient,
} from "viem";

import type { RelayChain } from "./relayer.js";

export interface ViemRelayChainOptions {
  publicClient: PublicClient;
  account: LocalAccount;
  chain: Chain;
  rpcUrl: string;
  /** How long to wait for a receipt before reporting the hash as unconfirmed. */
  receiptTimeoutMs?: number;
  /** Receipt polling; Monad produces a block about every 300 ms. */
  pollingIntervalMs?: number;
  /** Use `eth_sendRawTransactionSync`. On by default; Monad serves it. */
  syncSend?: boolean;
  /** Keep fees fresh in the background. On by default; tests turn it off. */
  refreshFees?: boolean;
}

/** How long a fee reading is reused. Monad's base fee sits at its floor almost all the time. */
const FEE_TTL_MS = 15_000;

export function createViemRelayChain(options: ViemRelayChainOptions): RelayChain {
  const { publicClient, account, chain } = options;
  const wallet = createWalletClient({ account, chain, transport: monadTransport({ chainId: chain.id, rpcUrl: options.rpcUrl }) });
  const timeout = options.receiptTimeoutMs ?? 60_000;
  const pollingInterval = options.pollingIntervalMs ?? 250;

  // Fees are kept fresh in the background, so a send never waits on a fee lookup. A send only reads
  // them itself when the background reading has gone stale or failed.
  let fees: { at: number; value: Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> } | undefined;
  const readFees = () => {
    const value = publicClient.estimateFeesPerGas().then(({ maxFeePerGas, maxPriorityFeePerGas }) => ({
      maxFeePerGas,
      maxPriorityFeePerGas,
    }));
    value.catch(() => (fees = undefined));
    fees = { at: Date.now(), value };
    return value;
  };
  const currentFees = () => (fees === undefined || Date.now() - fees.at > FEE_TTL_MS ? readFees() : fees.value);
  if (options.refreshFees !== false) {
    readFees().catch(() => undefined);
    setInterval(() => readFees().catch(() => undefined), FEE_TTL_MS / 3).unref();
  }

  let syncUnsupported = false;

  return {
    relayer: account.address,
    async call(call) {
      const { data } = await publicClient.call({ account: account.address, to: call.to, data: call.data });
      return data ?? "0x";
    },
    estimateGas(call) {
      return publicClient.estimateGas({ account: account.address, to: call.to, data: call.data });
    },
    allowance(token, owner, spender) {
      return publicClient.readContract({ address: token, abi: stablecoinAbi, functionName: "allowance", args: [owner, spender] });
    },
    pendingNonce() {
      return publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    },
    async send(call) {
      return wallet.sendTransaction({ account, chain, to: call.to, data: call.data, gas: call.gas, nonce: call.nonce, ...(await currentFees()) });
    },
    async waitForReceipt(hash) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout, pollingInterval });
      return { status: receipt.status, logs: receipt.logs, gasUsed: receipt.gasUsed };
    },
    ...(options.syncSend === false
      ? {}
      : {
          async sendAndWait(call) {
            if (!syncUnsupported) {
              try {
                // No timeout parameter: it is optional in EIP-7966, and not every node accepts it.
                const receipt = await wallet.sendTransactionSync({
                  account,
                  chain,
                  to: call.to,
                  data: call.data,
                  gas: call.gas,
                  nonce: call.nonce,
                  ...(await currentFees()),
                });
                return {
                  hash: receipt.transactionHash,
                  receipt: { status: receipt.status, logs: receipt.logs, gasUsed: receipt.gasUsed },
                };
              } catch (error) {
                // A node without the method broadcast nothing: fall back to send and poll, for good.
                if (!isMethodMissing(error)) throw error;
                syncUnsupported = true;
              }
            }
            const hash = await wallet.sendTransaction({
              account,
              chain,
              to: call.to,
              data: call.data,
              gas: call.gas,
              nonce: call.nonce,
              ...(await currentFees()),
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout, pollingInterval });
            return { hash, receipt: { status: receipt.status, logs: receipt.logs, gasUsed: receipt.gasUsed } };
          },
        }),
  };
}

/** True when the node answered that it does not know `eth_sendRawTransactionSync`. */
function isMethodMissing(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    const message = (current as { message?: unknown }).message;
    if (code === -32601) return true;
    if (typeof message === "string" && /method .*(not found|not supported|does not exist)|unsupported method/i.test(message)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
