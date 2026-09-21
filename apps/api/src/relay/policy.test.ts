import { mandateHubAbi, savingsRouterAbi, stablecoinAbi } from "@weir/shared";
import { encodeFunctionData, getAddress, maxUint256, parseAbi, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { MULTICALL3_ADDRESS } from "@weir/shared";

import { bundle, checkRelayCall, MAX_BUNDLE_CALLS, RelayPolicyError, type RelayPolicy } from "./policy.js";

const hub = getAddress("0x00000000000000000000000000000000000000a1");
const asset = getAddress("0x00000000000000000000000000000000000000b1");
const vault = getAddress("0x00000000000000000000000000000000000000b2");
const faucetToken = getAddress("0x00000000000000000000000000000000000000b3");
const stranger = getAddress("0x00000000000000000000000000000000000000c1");
const payer = getAddress("0x00000000000000000000000000000000000000d1");

const policy: RelayPolicy = { hub, permitTokens: [asset, vault], faucet: { token: faucetToken, maxAmount: 100_000_000n } };

const terms = {
  merchant: stranger,
  asset,
  vault: zeroAddress,
  manager: zeroAddress,
  amount: 1n,
  period: 60,
  startAt: 0n,
  maxPerCharge: 1n,
  maxTotal: 1n,
  expiresAt: 2n ** 40n,
  ref: `0x${"00".repeat(32)}` as const,
};
const sig = `0x${"11".repeat(65)}` as const;
const r = `0x${"22".repeat(32)}` as const;

const hubCall = (data: `0x${string}`) => ({ to: hub, data });
const permit = (token: Address, spender: Address) => ({
  to: token,
  data: encodeFunctionData({ abi: stablecoinAbi, functionName: "permit", args: [payer, spender, maxUint256, 1n, 27, r, r] }),
});

function refused(call: Parameters<typeof checkRelayCall>[1], pattern: RegExp): void {
  expect(() => checkRelayCall(policy, call)).toThrow(RelayPolicyError);
  expect(() => checkRelayCall(policy, call)).toThrow(pattern);
}

describe("the relay allowlist", () => {
  it("allows the three signed hub entry points", () => {
    const create = encodeFunctionData({ abi: mandateHubAbi, functionName: "createMandateWithSig", args: [payer, terms, 1n, 1n, sig] });
    expect(checkRelayCall(policy, hubCall(create))).toEqual({ kind: "createMandateWithSig", payer });
    const act = encodeFunctionData({ abi: mandateHubAbi, functionName: "actWithSig", args: [4n, 1, payer, 1n, 1n, sig] });
    expect(checkRelayCall(policy, hubCall(act))).toEqual({ kind: "actWithSig", mandateId: 4n, signer: payer });
    const manager = encodeFunctionData({ abi: mandateHubAbi, functionName: "setManagerWithSig", args: [4n, stranger, 1n, 1n, sig] });
    expect(checkRelayCall(policy, hubCall(manager))).toEqual({ kind: "setManagerWithSig", mandateId: 4n });
  });

  it("refuses every other hub function, including the unsigned twins", () => {
    refused(hubCall(encodeFunctionData({ abi: mandateHubAbi, functionName: "createMandate", args: [terms] })), /does not call createMandate on the hub/);
    refused(hubCall(encodeFunctionData({ abi: mandateHubAbi, functionName: "charge", args: [1n] })), /charges only alongside a mandate it installs/);
    refused(hubCall(encodeFunctionData({ abi: mandateHubAbi, functionName: "cancelMandate", args: [1n] })), /does not call cancelMandate/);
    refused(hubCall(encodeFunctionData({ abi: mandateHubAbi, functionName: "invalidateNonce", args: [1n] })), /does not call invalidateNonce/);
    refused(hubCall("0xdeadbeef"), /does not send that call to the hub/);
  });

  it("allows a permit on an accepted asset or the savings vault, with the hub as spender", () => {
    expect(checkRelayCall(policy, permit(asset, hub))).toMatchObject({ kind: "permit", token: asset, owner: payer });
    expect(checkRelayCall(policy, permit(vault, hub))).toMatchObject({ kind: "permit", token: vault });
  });

  it("refuses a permit to any other spender", () => {
    refused(permit(asset, stranger), /only submits permits whose spender is the hub/);
    refused(permit(vault, payer), /spender is the hub/);
  });

  it("refuses a permit on a token off the list, and any other token function", () => {
    refused(permit(stranger, hub), /does not send transactions to/);
    refused({ to: asset, data: encodeFunctionData({ abi: stablecoinAbi, functionName: "transfer", args: [stranger, 1n] }) }, /does not call transfer/);
    refused({ to: asset, data: encodeFunctionData({ abi: stablecoinAbi, functionName: "approve", args: [stranger, 1n] }) }, /does not call approve/);
    refused({ to: asset, data: encodeFunctionData({ abi: stablecoinAbi, functionName: "transferFrom", args: [payer, stranger, 1n] }) }, /does not call transferFrom/);
    // `mint` is the faucet's, and only on the faucet token.
    refused({ to: asset, data: encodeFunctionData({ abi: stablecoinAbi, functionName: "mint", args: [payer, 1n] }) }, /does not call mint/);
  });

  it("allows the faucet mint up to its amount, and nothing else there", () => {
    const mint = (amount: bigint) => ({ to: faucetToken, data: encodeFunctionData({ abi: stablecoinAbi, functionName: "mint", args: [payer, amount] }) });
    expect(checkRelayCall(policy, mint(100_000_000n))).toEqual({ kind: "mint", to: payer, amount: 100_000_000n });
    refused(mint(100_000_001n), /at most its configured amount/);
    refused(permit(faucetToken, hub), /does not call permit/);
    const noFaucet: RelayPolicy = { hub, permitTokens: [asset] };
    expect(() => checkRelayCall(noFaucet, mint(1n))).toThrow(/does not send transactions to/);
  });

  it("refuses any other target and any value", () => {
    const create = encodeFunctionData({ abi: mandateHubAbi, functionName: "createMandateWithSig", args: [payer, terms, 1n, 1n, sig] });
    refused({ to: stranger, data: create }, /does not send transactions to/);
    refused({ to: hub, data: create, value: 1n }, /never sends value/);
    const other = parseAbi(["function execute(address,bytes)"]);
    refused({ to: hub, data: encodeFunctionData({ abi: other, functionName: "execute", args: [stranger, "0x"] }) }, /does not send that call/);
  });
});

describe("bundles", () => {
  const withBundles: RelayPolicy = { ...policy, multicall: MULTICALL3_ADDRESS };
  const create = hubCall(
    encodeFunctionData({ abi: mandateHubAbi, functionName: "createMandateWithSig", args: [payer, terms, 1n, 1n, sig] }),
  );

  it("accepts a permit that may fail followed by a mandate that may not", () => {
    const allowed = checkRelayCall(
      withBundles,
      bundle(MULTICALL3_ADDRESS, [
        { ...permit(asset, hub), allowFailure: true },
        { ...create, allowFailure: false },
      ]),
    );
    expect(allowed.kind).toBe("bundle");
    expect(allowed.kind === "bundle" ? allowed.calls.map((call) => call.kind) : []).toEqual(["permit", "createMandateWithSig"]);
  });

  it("holds every part to the allowlist", () => {
    expect(() =>
      checkRelayCall(withBundles, bundle(MULTICALL3_ADDRESS, [{ ...permit(asset, stranger), allowFailure: true }])),
    ).toThrow(RelayPolicyError);
    expect(() =>
      checkRelayCall(withBundles, bundle(MULTICALL3_ADDRESS, [{ to: stranger, data: "0x12345678", allowFailure: false }])),
    ).toThrow(RelayPolicyError);
  });

  it("charges inside a bundle only beside a mandate it installs", () => {
    const charge = { ...hubCall(encodeFunctionData({ abi: mandateHubAbi, functionName: "charge", args: [7n] })), allowFailure: true };
    expect(checkRelayCall(withBundles, bundle(MULTICALL3_ADDRESS, [{ ...create, allowFailure: false }, charge]))).toMatchObject({
      kind: "bundle",
      calls: [{ kind: "createMandateWithSig" }, { kind: "charge", mandateId: 7n }],
    });
    expect(() => checkRelayCall(withBundles, bundle(MULTICALL3_ADDRESS, [charge]))).toThrow(/charges only alongside a mandate it installs/);
    // Required to succeed is allowed too: it is how the bundle is estimated.
    expect(checkRelayCall(withBundles, bundle(MULTICALL3_ADDRESS, [{ ...create, allowFailure: false }, { ...charge, allowFailure: false }]))).toMatchObject({
      kind: "bundle",
    });
  });

  it("lets only a permit or a charge fail", () => {
    expect(() => checkRelayCall(withBundles, bundle(MULTICALL3_ADDRESS, [{ ...create, allowFailure: true }]))).toThrow(
      /only a permit/,
    );
  });

  it("refuses a bundle inside a bundle", () => {
    const inner = bundle(MULTICALL3_ADDRESS, [{ ...create, allowFailure: false }]);
    expect(() => checkRelayCall(withBundles, bundle(MULTICALL3_ADDRESS, [{ ...inner, allowFailure: false }]))).toThrow(
      RelayPolicyError,
    );
  });

  it("refuses an empty bundle and an oversized one", () => {
    expect(() => checkRelayCall(withBundles, bundle(MULTICALL3_ADDRESS, []))).toThrow(RelayPolicyError);
    const many = Array.from({ length: MAX_BUNDLE_CALLS + 1 }, () => ({ ...create, allowFailure: false }));
    expect(() => checkRelayCall(withBundles, bundle(MULTICALL3_ADDRESS, many))).toThrow(RelayPolicyError);
  });

  it("refuses Multicall3 entirely when the policy names none", () => {
    expect(() => checkRelayCall(policy, bundle(MULTICALL3_ADDRESS, [{ ...create, allowFailure: false }]))).toThrow(
      RelayPolicyError,
    );
  });
});

describe("the savings router", () => {
  const router = getAddress("0x00000000000000000000000000000000000000e1");
  const withRouter: RelayPolicy = { ...policy, router };
  const routerCall = (data: `0x${string}`) => ({ to: router, data });
  const depositFor = routerCall(
    encodeFunctionData({ abi: savingsRouterAbi, functionName: "depositFor", args: [payer, asset, 5n, 1n, 27, r, r] }),
  );
  const withdrawFor = routerCall(
    encodeFunctionData({ abi: savingsRouterAbi, functionName: "withdrawFor", args: [payer, asset, 5n, 6n, 1n, 27, r, r] }),
  );

  it("allows the two signed moves", () => {
    expect(checkRelayCall(withRouter, depositFor)).toEqual({ kind: "savings", direction: "deposit", owner: payer, asset, amount: 5n });
    expect(checkRelayCall(withRouter, withdrawFor)).toEqual({ kind: "savings", direction: "withdraw", owner: payer, asset, amount: 5n });
  });

  it("refuses the unsigned twins, which would move the relayer's own funds", () => {
    const deposit = routerCall(encodeFunctionData({ abi: savingsRouterAbi, functionName: "deposit", args: [asset, 5n] }));
    const withdraw = routerCall(encodeFunctionData({ abi: savingsRouterAbi, functionName: "withdraw", args: [asset, 5n] }));
    expect(() => checkRelayCall(withRouter, deposit)).toThrow(/does not call deposit/);
    expect(() => checkRelayCall(withRouter, withdraw)).toThrow(/does not call withdraw/);
  });

  it("refuses the router entirely when the policy names none", () => {
    expect(() => checkRelayCall(policy, depositFor)).toThrow(RelayPolicyError);
  });

  it("moves a business's payout only on a permit to the relayer itself, and only in dollars", () => {
    const relayer = getAddress("0x00000000000000000000000000000000000000e1");
    const withPayouts: RelayPolicy = { ...policy, multicall: MULTICALL3_ADDRESS, payouts: { relayer, assets: [asset] } };
    expect(checkRelayCall(withPayouts, permit(asset, relayer))).toMatchObject({ kind: "payoutPermit", token: asset, owner: payer });
    const transfer = (token: Address) => ({
      to: token,
      data: encodeFunctionData({ abi: stablecoinAbi, functionName: "transferFrom", args: [payer, stranger, 5n] }),
    });
    expect(checkRelayCall(withPayouts, transfer(asset))).toEqual({ kind: "payout", token: asset, from: payer, to: stranger, amount: 5n });
    // Never a vault's shares, never another spender, never inside a bundle, and never without payouts set up.
    expect(() => checkRelayCall(withPayouts, transfer(vault))).toThrow(/does not call transferFrom/);
    expect(() => checkRelayCall(withPayouts, permit(asset, stranger))).toThrow(/spender is the hub/);
    expect(() => checkRelayCall(withPayouts, bundle(MULTICALL3_ADDRESS, [{ ...transfer(asset), allowFailure: false }]))).toThrow(RelayPolicyError);
    expect(() => checkRelayCall(policy, transfer(asset))).toThrow(/does not call transferFrom/);
  });
});
