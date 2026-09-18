/**
 * The little of the MetaMask Agent Wallet host this plugin touches.
 *
 * The host hands a plugin command a restricted context. Two members matter here:
 *
 * - `walletStateManager`, behind the `wallet-read` capability: the wallet roster and which wallet
 *   is selected, from which the payer's address comes.
 * - `walletExecutor`, behind `wallet-submit`: the one door to the wallet's keys. Besides
 *   transactions it takes `{ kind: "typed-data", chainId, typedData, intent }` requests, signs them
 *   with the selected wallet under its policy (a server wallet may ask for approval on a paired
 *   device), and answers `{ kind: "signature", signature, status }`. Weir needs nothing else: every
 *   Weir action is a signature, and the relayer sends the transaction.
 *
 * The context's members are typed against a package the CLI bundles and does not publish, so this
 * module describes the structural subset it relies on and casts the context onto it once.
 */

import type { CommandIO } from "@metamask/agent-wallet/plugin";
import { getAddress, type Address, type Hex } from "viem";

import { messageOf, WeirError } from "./core/errors.js";
import type { Signer } from "./core/signer.js";

export interface WalletRecordLike {
  readonly address?: string | undefined;
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  /** `"evm"` or `"solana"`; absent on older records, which are EVM. */
  readonly namespace?: string | undefined;
}

export interface WalletStateLike {
  readonly byokWallets?: readonly WalletRecordLike[] | undefined;
  readonly remoteWallets?: readonly WalletRecordLike[] | undefined;
  readonly selectedWallet?:
    | {
        readonly mode?: string | undefined;
        readonly namespace?: string | undefined;
        readonly ref?: unknown;
      }
    | undefined;
}

export interface TypedDataJob {
  readonly kind: "typed-data";
  readonly chainId: number;
  readonly typedData: unknown;
  readonly intent: { readonly summary: string; readonly action: string };
}

export interface SignatureResultLike {
  readonly kind?: string;
  readonly signature?: string | undefined;
  readonly status?: string | undefined;
  readonly failureCode?: string | undefined;
  readonly failureDescription?: string | undefined;
}

export type ExecutorLike = (request: TypedDataJob, options?: { signal?: AbortSignal }) => Promise<SignatureResultLike>;

/** `this.ctx`, as far as this plugin reaches into it. */
export interface HostContextLike {
  readonly walletStateManager?: { read(): WalletStateLike } | undefined;
  readonly walletExecutor?: ((io: CommandIO, source: string) => Promise<ExecutorLike>) | undefined;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const isEvm = (record: WalletRecordLike): record is WalletRecordLike & { address: string } =>
  (record.namespace === undefined || record.namespace === "evm") && typeof record.address === "string" && EVM_ADDRESS.test(record.address);

function matches(record: WalletRecordLike, ref: unknown): boolean {
  if (typeof ref === "string") return record.id === ref || record.address?.toLowerCase() === ref.toLowerCase();
  if (typeof ref !== "object" || ref === null) return false;
  const { id, address, name } = ref as { id?: unknown; address?: unknown; name?: unknown };
  if (typeof id === "string") return record.id === id;
  if (typeof address === "string") return record.address?.toLowerCase() === address.toLowerCase();
  if (typeof name === "string") return record.name === name;
  return false;
}

/**
 * The address the wallet signs with: the selected EVM wallet in the selected mode, or the first EVM
 * wallet on that roster, which is what the host itself falls back to.
 */
export function selectedAddress(state: WalletStateLike): Address | undefined {
  const selected = state.selectedWallet;
  const remote = state.remoteWallets ?? [];
  const byok = state.byokWallets ?? [];
  const roster = (selected?.mode === "byok" ? byok : selected?.mode === "server" ? remote : [...remote, ...byok]).filter(isEvm);
  const namespaceOk = selected?.namespace === undefined || selected.namespace === "evm";
  const chosen = namespaceOk && selected?.ref !== undefined ? roster.find((record) => matches(record, selected.ref)) : undefined;
  const address = (chosen ?? roster[0])?.address;
  return address === undefined ? undefined : getAddress(address);
}

/** True for the host's refusal of a member the plugin was not granted. */
function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "PERMISSION_DENIED";
}

/** A host error with its own code and remedy, such as a denied approval or an expired login. */
function isHostError(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { hint?: unknown }).hint === "string"
  );
}

export function capabilityMissing(capability: "wallet-read" | "wallet-submit"): WeirError {
  return new WeirError(
    "CAPABILITY_MISSING",
    `This command was not granted the \`${capability}\` capability, so it cannot ${capability === "wallet-read" ? "see the wallet's address" : "ask the wallet to sign"}`,
    "A plugin added with `mm plugins link` runs with no wallet access. Install it instead and approve what it asks for: from the Weir repository, `pnpm --filter @weir/agent-wallet-plugin mm:link --install`.",
  );
}

/** The selected wallet's address, from `wallet-read`. */
export function walletAddress(ctx: HostContextLike): Address {
  let state: WalletStateLike | undefined;
  try {
    state = ctx.walletStateManager?.read();
  } catch (error) {
    if (isPermissionDenied(error)) throw capabilityMissing("wallet-read");
    throw new WeirError("WALLET_MISSING", `The wallet's state could not be read: ${messageOf(error)}`, "Run `mm doctor` to check the CLI's setup.");
  }
  if (state === undefined) throw capabilityMissing("wallet-read");
  const address = selectedAddress(state);
  if (address === undefined) {
    throw new WeirError("WALLET_MISSING", "This Agent Wallet has no EVM address yet", "Run `mm login`, then `mm init` to set a wallet up, or `mm wallet select` to choose one.");
  }
  return address;
}

/**
 * A signer over the host's wallet executor. The executor is asked for once, on the first signature,
 * so a dry run never touches `wallet-submit`.
 */
export function walletSigner(ctx: HostContextLike, io: CommandIO, commandId: string, chainId: number, address: Address): Signer {
  let executor: Promise<ExecutorLike> | undefined;

  const open = (): Promise<ExecutorLike> => {
    executor ??= (async () => {
      let factory: HostContextLike["walletExecutor"];
      try {
        factory = ctx.walletExecutor;
      } catch (error) {
        if (isPermissionDenied(error)) throw capabilityMissing("wallet-submit");
        throw error;
      }
      if (factory === undefined) throw capabilityMissing("wallet-submit");
      try {
        return await factory(io, commandId);
      } catch (error) {
        if (isPermissionDenied(error)) throw capabilityMissing("wallet-submit");
        if (isHostError(error)) throw error;
        throw new WeirError("SIGNING_FAILED", `The wallet would not open for signing: ${messageOf(error)}`, "Run `mm auth status` and `mm wallet address` to check the wallet.");
      }
    })();
    return executor;
  };

  return {
    address,
    async signTypedData({ typedData, summary }) {
      const run = await open();
      let result: SignatureResultLike;
      try {
        result = await run({ kind: "typed-data", chainId, typedData, intent: { summary, action: "sign" } }, { signal: io.signal });
      } catch (error) {
        if (isHostError(error)) throw error;
        throw new WeirError("SIGNING_FAILED", `The wallet did not sign "${summary}": ${messageOf(error)}`, "Nothing was sent. Run the command again.");
      }
      return signatureFrom(result, summary);
    },
  };
}

/** The signature in an executor answer, refusing an answer that carries none. */
export function signatureFrom(result: SignatureResultLike, summary: string): Hex {
  const raw = result.signature ?? "";
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (result.failureCode !== undefined || !/^0x[0-9a-fA-F]{130,}$/.test(hex)) {
    const status = result.status ?? "no status";
    const reason = result.failureDescription ?? result.failureCode;
    throw new WeirError(
      "SIGNING_FAILED",
      `The wallet did not sign "${summary}": it answered ${status}${reason === undefined ? "" : ` (${reason})`}`,
      status === "AWAITING_MFA" || status === "PENDING"
        ? "The request is waiting for approval. Approve it where the wallet asks, then run the command again."
        : "Nothing was sent. Run the command again.",
    );
  }
  return hex as Hex;
}
