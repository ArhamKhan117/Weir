import { ACTIONS, refFromString } from "@weir/shared";
import { encodeAbiParameters, hashStruct, hashTypedData, keccak256, recoverTypedDataAddress, toBytes, zeroAddress, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { ASSET, checkoutFor, fakeApi, fakeChain, fakeDeps, HUB, MERCHANT, NOW, periodicMandate, ROUTER, VAULT, decodeWire, hostWireEncoding } from "../test/fixtures.js";
import { prepareAction } from "./actions.js";
import { prepareMove, readSavings } from "./savings.js";
import { localSigner } from "./signer.js";
import { prepareInstall } from "./subscribe.js";
import { SIGNATURE_WINDOW } from "./terms.js";

// The type strings `MandateHub.sol` hashes into its `*_TYPEHASH` constants, and EIP-2612's, copied
// verbatim. Typed data that encodes to anything else is signed by the wallet and refused by the hub.
const TERMS =
  "Terms(address merchant,address asset,address vault,address manager,uint96 amount,uint32 period,uint64 startAt,uint96 maxPerCharge,uint96 maxTotal,uint64 expiresAt,bytes32 ref)";
const MANDATE = `Mandate(address payer,Terms terms,uint256 nonce,uint256 deadline)${TERMS}`;
const ACTION = "MandateAction(uint256 mandateId,uint8 action,uint256 nonce,uint256 deadline)";
const PERMIT = "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)";

// A fixed test key: it signs nothing outside this file.
const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const typeHash = (text: string) => keccak256(toBytes(text));

/** The struct hash of a typed-data payload's message, as the hub computes it for `primaryType`. */
const structHash = (typed: TypedDataDefinition, primaryType: string) =>
  hashStruct({ types: typed.types, primaryType, data: typed.message } as Parameters<typeof hashStruct>[0]);

/** A payload's message, with the fields a test reads. */
const messageOf = <T>(typed: TypedDataDefinition) => (typed as unknown as { message: T }).message;

function permitStructHash(message: { owner: string; spender: string; value: bigint; nonce: bigint; deadline: bigint }) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [typeHash(PERMIT), message.owner as `0x${string}`, message.spender as `0x${string}`, message.value, message.nonce, message.deadline],
    ),
  );
}

describe("subscribe builds the typed data the hub and the token verify", () => {
  it("builds exactly the web checkout's terms: the plan's amounts, paying the merchant, the wallet as manager", async () => {
    const plan = await prepareInstall(fakeDeps(), { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address);
    expect(plan.terms).toEqual({
      merchant: MERCHANT,
      asset: ASSET,
      vault: zeroAddress,
      manager: payer.address,
      amount: 9_990_000n,
      period: 2_592_000,
      startAt: 0n,
      maxPerCharge: 9_990_000n,
      maxTotal: 119_880_000n,
      expiresAt: BigInt(NOW + 31_104_000),
      ref: refFromString("pln_5xjqdh77j4gflgvy"),
    });
    expect(plan.mandate.deadline).toBe(NOW + SIGNATURE_WINDOW);
  });

  it("encodes the mandate with the hub's Mandate and Terms type strings, under the checkout's domain", async () => {
    const plan = await prepareInstall(fakeDeps(), { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address);
    const typed = plan.mandate.request.typedData as TypedDataDefinition & { message: { nonce: bigint } };
    const t = plan.terms;
    const termsHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "address" },
          { type: "address" },
          { type: "address" },
          { type: "address" },
          { type: "uint96" },
          { type: "uint32" },
          { type: "uint64" },
          { type: "uint96" },
          { type: "uint96" },
          { type: "uint64" },
          { type: "bytes32" },
        ],
        [typeHash(TERMS), t.merchant, t.asset, t.vault, t.manager, t.amount, t.period, t.startAt, t.maxPerCharge, t.maxTotal, t.expiresAt, t.ref],
      ),
    );
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
        [typeHash(MANDATE), payer.address, termsHash, typed.message.nonce, BigInt(plan.mandate.deadline)],
      ),
    );
    expect(structHash(typed, "Mandate")).toBe(expected);
    expect(typed.domain).toEqual({ name: "Weir", version: "1", chainId: 10143, verifyingContract: HUB });
  });

  it("permits the hub the lifetime cap on top of the current allowance, under the token's own domain", async () => {
    const deps = fakeDeps({ chain: fakeChain(10143, { allowance: 5_000_000n, permitNonce: 7n }) });
    const plan = await prepareInstall(deps, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address);
    const typed = plan.permit.request.typedData as TypedDataDefinition & { message: Parameters<typeof permitStructHash>[0] };
    expect(typed.message).toEqual({ owner: payer.address, spender: HUB, value: 124_880_000n, nonce: 7n, deadline: BigInt(NOW + SIGNATURE_WINDOW) });
    expect(typed.domain).toEqual({ name: "Test AUSD", version: "1", chainId: 10143, verifyingContract: ASSET });
    expect(structHash(typed, "Permit")).toBe(permitStructHash(typed.message));
    expect(plan.permit.token).toBe(ASSET);
  });

  it("draws from savings by permitting the vault's shares for the cap and naming the vault in the terms", async () => {
    // Two shares per dollar unit: the permit is counted in shares, not dollars.
    const deps = fakeDeps({ chain: fakeChain(10143, { sharesPerUnit: { numerator: 2n, denominator: 1n }, saved: 20_000_000n }) });
    const plan = await prepareInstall(deps, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: true }, payer.address);
    const typed = plan.permit.request.typedData as TypedDataDefinition & { message: { value: bigint } };
    expect(plan.terms.vault).toBe(VAULT);
    expect(plan.permit.token).toBe(VAULT);
    expect(typed.domain).toMatchObject({ verifyingContract: VAULT, name: "Test AUSD Savings" });
    expect(typed.message.value).toBe(239_760_000n);
    expect(plan.funds).toEqual({ from: "savings", available: 20_000_000n, firstCharge: 9_990_000n, enough: true });
  });

  it("names a different manager, or none, when asked", async () => {
    const other = "0x00000000000000000000000000000000000000Cc";
    const managed = await prepareInstall(fakeDeps(), { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false, manager: other }, payer.address);
    expect(managed.terms.manager).toBe(other);
    const none = await prepareInstall(fakeDeps(), { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false, manager: zeroAddress }, payer.address);
    expect(none.terms.manager).toBe(zeroAddress);
  });

  it("starts the first charge after a trial and marks a stream with a zero period", async () => {
    const trial = fakeDeps({ api: fakeApi({ checkout: checkoutFor({ trialDays: 7 }) }) });
    expect((await prepareInstall(trial, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address)).terms.startAt).toBe(BigInt(NOW + 7 * 86_400));
    const stream = fakeDeps({ api: fakeApi({ checkout: checkoutFor({ mode: "streaming", period: 0, amount: "100", maxPerCharge: "5000000", maxTotal: "20000000" }) }) });
    const streamPlan = await prepareInstall(stream, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address);
    expect(streamPlan.terms.period).toBe(0);
    expect(streamPlan.funds.firstCharge).toBe(0n);
  });

  it("produces signatures that recover to the payer, even after the host's wire encoding", async () => {
    const plan = await prepareInstall(fakeDeps(), { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address);
    for (const request of [plan.permit.request, plan.mandate.request]) {
      const signature = await localSigner(payer).signTypedData(request);
      expect(await recoverTypedDataAddress({ ...request.typedData, signature })).toBe(payer.address);

      // The host adds EIP712Domain from the domain's fields and writes bigints as hex; decoded, the
      // message hashes to the same digest, so the wallet signs what the hub will check.
      const wire = hostWireEncoding(request.typedData);
      const withHostDomainType = { ...decodeWire(wire), types: wire.types };
      expect(hashTypedData(withHostDomainType as never)).toBe(hashTypedData(request.typedData));
    }
  });
});

describe("actions build the MandateAction the hub verifies", () => {
  it("encodes stop as ACTION_CANCEL with the hub's type string, under the hub's own domain", async () => {
    const chain = fakeChain(10143, { mandates: new Map([[3n, periodicMandate({ payer: payer.address })]]) });
    const plan = await prepareAction(fakeDeps({ chain }), { mandateId: 3n, verb: "stop" }, payer.address);
    const typed = plan.request.typedData as TypedDataDefinition & { message: { mandateId: bigint; action: number; nonce: bigint; deadline: bigint } };
    expect(typed.message.action).toBe(ACTIONS.cancel);
    expect(typed.domain).toEqual({ name: "Weir", version: "1", chainId: 10143, verifyingContract: HUB });
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }],
        [typeHash(ACTION), 3n, ACTIONS.cancel, typed.message.nonce, typed.message.deadline],
      ),
    );
    expect(structHash(typed, "MandateAction")).toBe(expected);
    expect(plan.role).toBe("payer");
  });

  it("encodes pause and resume of a stream, and lets the manager sign", async () => {
    const stream = periodicMandate({ period: 0, amount: 100n, manager: payer.address });
    const paused = { ...stream, pausedAt: BigInt(NOW - 60) };
    const pause = await prepareAction(fakeDeps({ chain: fakeChain(10143, { mandates: new Map([[3n, stream]]) }) }), { mandateId: 3n, verb: "pause" }, payer.address);
    const resume = await prepareAction(fakeDeps({ chain: fakeChain(10143, { mandates: new Map([[3n, paused]]) }) }), { mandateId: 3n, verb: "resume" }, payer.address);
    expect(messageOf<{ action: number }>(pause.request.typedData).action).toBe(ACTIONS.pause);
    expect(messageOf<{ action: number }>(resume.request.typedData).action).toBe(ACTIONS.resume);
    expect(pause.role).toBe("manager");
  });
});

describe("savings moves permit the router, and nothing else", () => {
  it("permits the asset for the amount going in", async () => {
    const deps = fakeDeps();
    const state = await readSavings(deps, payer.address);
    const plan = await prepareMove(deps, state, { direction: "deposit", amount: 5_000_000n });
    const typed = plan.request.typedData as TypedDataDefinition & { message: Parameters<typeof permitStructHash>[0] };
    expect(typed.domain).toMatchObject({ verifyingContract: ASSET });
    expect(typed.message).toMatchObject({ owner: payer.address, spender: ROUTER, value: 5_000_000n });
    expect(structHash(typed, "Permit")).toBe(permitStructHash(typed.message));
  });

  it("permits the vault's shares for exactly what the withdrawal burns going out", async () => {
    const deps = fakeDeps({ chain: fakeChain(10143, { saved: 10_000_000n, sharesPerUnit: { numerator: 95n, denominator: 100n } }) });
    const state = await readSavings(deps, payer.address);
    const plan = await prepareMove(deps, state, { direction: "withdraw", amount: 2_000_000n });
    const typed = plan.request.typedData as TypedDataDefinition & { message: { spender: string; value: bigint } };
    expect(typed.domain).toMatchObject({ verifyingContract: VAULT });
    expect(typed.message.spender).toBe(ROUTER);
    expect(plan.maxShares).toBe(1_900_000n);
    expect(typed.message.value).toBe(1_900_000n);
  });
});
