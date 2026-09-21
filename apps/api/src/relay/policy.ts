/**
 * The relayer's allowlist: the only transactions its key will ever sign.
 *
 * The relayer holds a funded key and accepts requests from anyone, so what it may send is fixed
 * here, checked by decoding the calldata itself rather than by trusting whichever code built it:
 *
 * - `createMandateWithSig`, `actWithSig` and `setManagerWithSig` on the hub. Each is authorized
 *   by the payer's or the manager's own signature, which the hub verifies.
 * - `permit` on one of the hub's accepted assets or a known savings vault, and only with the hub
 *   as spender. A permit naming any other spender would turn the relayer into a way of granting
 *   allowances to strangers.
 * - `depositFor` and `withdrawFor` on the savings router, when one is deployed. Each carries the
 *   owner's permit to the router, and the router moves money only within the owner's own account.
 * - `mint` on the Testnet faucet token, to at most the configured faucet amount, when the network
 *   has a faucet.
 * - A business's payout: `permit` on an accepted asset naming the relayer itself as spender, then
 *   `transferFrom` on that asset. The relayer can only ever move what an owner permitted it, for
 *   exactly the amount of one payout; the API admits only a signed-in business's own wallet.
 * - `aggregate3` on Multicall3, bundling calls from this list into one transaction, so an install
 *   is one transaction rather than two. Every call inside is checked by the same rules, only a
 *   permit may be marked as allowed to fail (a front-run permit is harmless), and bundles do not
 *   nest.
 * - `charge` on the hub, only inside a bundle that also creates a mandate: a payment that is one
 *   charge due now ("send now") arrives with its install. Charging is permissionless and the keeper
 *   would do it a moment later; this only saves the wait. The bundle sent lets it fail; the one
 *   estimated does not, so the estimate covers a charge that succeeds.
 *
 * Nothing else: no value, no other function on these contracts, no other contract.
 */

import { mandateHubAbi, savingsRouterAbi, stablecoinAbi } from "@weir/shared";
import { decodeFunctionData, encodeFunctionData, isAddressEqual, type Address, type Hex } from "viem";

/** The one Multicall3 function the relayer uses. */
export const aggregate3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

/** Most calls one bundle may carry. An install needs two. */
export const MAX_BUNDLE_CALLS = 4;

export interface RelayPolicy {
  hub: Address;
  /** Multicall3, for bundles; without it the relayer sends single calls only. */
  multicall?: Address;
  /** Tokens a permit may be submitted on: accepted assets and known savings vaults. */
  permitTokens: readonly Address[];
  /** The Testnet faucet, when there is one. */
  faucet?: { token: Address; maxAmount: bigint };
  /** The savings router, when one is deployed. */
  router?: Address;
  /** For payouts: the relayer's own address, and the assets (never vaults) a payout may move. */
  payouts?: { relayer: Address; assets: readonly Address[] };
}

export interface RelayCall {
  to: Address;
  data: Hex;
  /** Never set by this API; present so a call carrying value is refused rather than ignored. */
  value?: bigint;
}

export type AllowedCall =
  | { kind: "createMandateWithSig"; payer: Address }
  | { kind: "actWithSig"; mandateId: bigint; signer: Address }
  | { kind: "setManagerWithSig"; mandateId: bigint }
  | { kind: "charge"; mandateId: bigint }
  | { kind: "permit"; token: Address; owner: Address; value: bigint }
  | { kind: "mint"; to: Address; amount: bigint }
  | { kind: "savings"; direction: "deposit" | "withdraw"; owner: Address; asset: Address; amount: bigint }
  | { kind: "payoutPermit"; token: Address; owner: Address; value: bigint }
  | { kind: "payout"; token: Address; from: Address; to: Address; amount: bigint }
  | { kind: "bundle"; calls: AllowedCall[] };

/** One call inside a bundle. */
export interface BundledCall extends RelayCall {
  /** Only a permit or a charge may fail without failing the bundle. */
  allowFailure: boolean;
}

/** The single call that sends `calls` in one transaction through Multicall3. */
export function bundle(multicall: Address, calls: readonly BundledCall[]): RelayCall {
  return {
    to: multicall,
    data: encodeFunctionData({
      abi: aggregate3Abi,
      functionName: "aggregate3",
      args: [calls.map((call) => ({ target: call.to, allowFailure: call.allowFailure, callData: call.data }))],
    }),
  };
}

export class RelayPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayPolicyError";
  }
}

const HUB_FUNCTIONS = new Set(["createMandateWithSig", "actWithSig", "setManagerWithSig"]);

function decodeOrRefuse<T>(decode: () => T, target: string): T {
  try {
    return decode();
  } catch {
    throw new RelayPolicyError(`the relayer does not send that call to ${target}`);
  }
}

/**
 * What `call` is, when the policy allows it.
 *
 * @throws {RelayPolicyError} for anything else.
 */
export function checkRelayCall(policy: RelayPolicy, call: RelayCall, inBundle = false): AllowedCall {
  if (call.value !== undefined && call.value !== 0n) throw new RelayPolicyError("the relayer never sends value");

  if (policy.multicall !== undefined && isAddressEqual(call.to, policy.multicall)) {
    const decoded = decodeOrRefuse(() => decodeFunctionData({ abi: aggregate3Abi, data: call.data }), "Multicall3");
    const [inner] = decoded.args;
    if (inner.length === 0 || inner.length > MAX_BUNDLE_CALLS) {
      throw new RelayPolicyError(`a bundle carries between 1 and ${MAX_BUNDLE_CALLS} calls`);
    }
    // Checked against the policy without Multicall3, so a bundle can never contain a bundle.
    const flat: RelayPolicy = { ...policy, multicall: undefined };
    const calls = inner.map((entry) => {
      const allowed = checkRelayCall(flat, { to: entry.target, data: entry.callData }, true);
      if (entry.allowFailure && allowed.kind !== "permit" && allowed.kind !== "charge") {
        throw new RelayPolicyError("only a permit or a charge may be allowed to fail inside a bundle");
      }
      return allowed;
    });
    if (calls.some((c) => c.kind === "charge") && !calls.some((c) => c.kind === "createMandateWithSig")) {
      throw new RelayPolicyError("the relayer charges only alongside a mandate it installs");
    }
    return { kind: "bundle", calls };
  }

  if (isAddressEqual(call.to, policy.hub)) {
    const decoded = decodeOrRefuse(() => decodeFunctionData({ abi: mandateHubAbi, data: call.data }), "the hub");
    if (decoded.functionName === "charge") {
      if (!inBundle) throw new RelayPolicyError("the relayer charges only alongside a mandate it installs");
      return { kind: "charge", mandateId: decoded.args[0] };
    }
    if (!HUB_FUNCTIONS.has(decoded.functionName)) {
      throw new RelayPolicyError(`the relayer does not call ${decoded.functionName} on the hub`);
    }
    switch (decoded.functionName) {
      case "createMandateWithSig":
        return { kind: "createMandateWithSig", payer: decoded.args[0] };
      case "actWithSig":
        return { kind: "actWithSig", mandateId: decoded.args[0], signer: decoded.args[2] };
      case "setManagerWithSig":
        return { kind: "setManagerWithSig", mandateId: decoded.args[0] };
      default:
        throw new RelayPolicyError(`the relayer does not call ${decoded.functionName} on the hub`);
    }
  }

  if (policy.router !== undefined && isAddressEqual(call.to, policy.router)) {
    const decoded = decodeOrRefuse(() => decodeFunctionData({ abi: savingsRouterAbi, data: call.data }), "the savings router");
    switch (decoded.functionName) {
      case "depositFor":
        return { kind: "savings", direction: "deposit", owner: decoded.args[0], asset: decoded.args[1], amount: decoded.args[2] };
      case "withdrawFor":
        return { kind: "savings", direction: "withdraw", owner: decoded.args[0], asset: decoded.args[1], amount: decoded.args[2] };
      default:
        throw new RelayPolicyError(`the relayer does not call ${decoded.functionName} on the savings router`);
    }
  }

  const permitToken = policy.permitTokens.find((token) => isAddressEqual(token, call.to));
  const faucetToken = policy.faucet !== undefined && isAddressEqual(policy.faucet.token, call.to) ? policy.faucet : undefined;
  if (permitToken === undefined && faucetToken === undefined) {
    throw new RelayPolicyError(`the relayer does not send transactions to ${call.to}`);
  }

  const decoded = decodeOrRefuse(() => decodeFunctionData({ abi: stablecoinAbi, data: call.data }), call.to);
  const payoutAsset = policy.payouts?.assets.some((asset) => isAddressEqual(asset, call.to)) === true ? call.to : undefined;
  if (decoded.functionName === "permit" && payoutAsset !== undefined && policy.payouts !== undefined && !inBundle) {
    const [owner, spender, value] = decoded.args;
    if (isAddressEqual(spender, policy.payouts.relayer)) return { kind: "payoutPermit", token: payoutAsset, owner, value };
  }
  if (decoded.functionName === "transferFrom" && payoutAsset !== undefined && !inBundle) {
    const [from, to, amount] = decoded.args;
    return { kind: "payout", token: payoutAsset, from, to, amount };
  }
  if (decoded.functionName === "permit" && permitToken !== undefined) {
    const [owner, spender, value] = decoded.args;
    if (!isAddressEqual(spender, policy.hub)) {
      throw new RelayPolicyError("the relayer only submits permits whose spender is the hub");
    }
    return { kind: "permit", token: permitToken, owner, value };
  }
  if (decoded.functionName === "mint" && faucetToken !== undefined) {
    const [to, amount] = decoded.args;
    if (amount > faucetToken.maxAmount) throw new RelayPolicyError("the faucet mints at most its configured amount");
    return { kind: "mint", to, amount };
  }
  throw new RelayPolicyError(`the relayer does not call ${decoded.functionName} on ${call.to}`);
}
