import { domainSeparator, encodeAbiParameters, hashStruct, hashTypedData, keccak256, toBytes, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  ACTIONS,
  ACTION_TYPES,
  MANDATE_TYPES,
  SET_MANAGER_TYPES,
  createMandateTypedData,
  hubDomain,
  permitTypedData,
  randomNonce,
  refFromString,
} from "./eip712.js";
import { MAINNET_AUSD } from "./chains.js";
import type { MandateTerms } from "./types.js";

// The type strings `MandateHub.sol` hashes into its `*_TYPEHASH` constants, copied verbatim.
// A client whose types encode to anything else signs digests the hub rejects.
const TERMS = "Terms(address merchant,address asset,address vault,address manager,uint96 amount,uint32 period,uint64 startAt,uint96 maxPerCharge,uint96 maxTotal,uint64 expiresAt,bytes32 ref)";
const MANDATE = `Mandate(address payer,Terms terms,uint256 nonce,uint256 deadline)${TERMS}`;
const ACTION = "MandateAction(uint256 mandateId,uint8 action,uint256 nonce,uint256 deadline)";
const SET_MANAGER = "SetManager(uint256 mandateId,address manager,uint256 nonce,uint256 deadline)";

const terms: MandateTerms = {
  merchant: "0x00000000000000000000000000000000000000aa",
  asset: MAINNET_AUSD.address,
  vault: "0x0000000000000000000000000000000000000000",
  manager: "0x00000000000000000000000000000000000000bb",
  amount: 9_990_000n,
  period: 2_592_000,
  startAt: 0n,
  maxPerCharge: 9_990_000n,
  maxTotal: 119_880_000n,
  expiresAt: 1_900_000_000n,
  ref: refFromString("plan_basic"),
};

describe("typed data matches the hub's type strings", () => {
  it("encodes Terms exactly as the hub's abi.encode(TERMS_TYPEHASH, terms)", () => {
    const expected = keccak256(
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
        [
          keccak256(toBytes(TERMS)),
          terms.merchant,
          terms.asset,
          terms.vault,
          terms.manager,
          terms.amount,
          terms.period,
          terms.startAt,
          terms.maxPerCharge,
          terms.maxTotal,
          terms.expiresAt,
          terms.ref,
        ],
      ),
    );
    expect(hashStruct({ types: MANDATE_TYPES, primaryType: "Terms", data: terms })).toBe(expected);
  });

  it("encodes the nested Mandate type with Terms appended", () => {
    const payer = "0x00000000000000000000000000000000000000cc";
    const termsHash = hashStruct({ types: MANDATE_TYPES, primaryType: "Terms", data: terms });
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
        [keccak256(toBytes(MANDATE)), payer, termsHash, 7n, 99n],
      ),
    );
    expect(
      hashStruct({ types: MANDATE_TYPES, primaryType: "Mandate", data: { payer, terms, nonce: 7n, deadline: 99n } }),
    ).toBe(expected);
  });

  it("encodes the action and manager types", () => {
    const action = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }],
        [keccak256(toBytes(ACTION)), 5n, ACTIONS.pause, 1n, 2n],
      ),
    );
    expect(
      hashStruct({
        types: ACTION_TYPES,
        primaryType: "MandateAction",
        data: { mandateId: 5n, action: ACTIONS.pause, nonce: 1n, deadline: 2n },
      }),
    ).toBe(action);

    const setManager = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
        [keccak256(toBytes(SET_MANAGER)), 5n, zeroAddress, 1n, 2n],
      ),
    );
    expect(
      hashStruct({
        types: SET_MANAGER_TYPES,
        primaryType: "SetManager",
        data: { mandateId: 5n, manager: zeroAddress, nonce: 1n, deadline: 2n },
      }),
    ).toBe(setManager);
  });

  it("builds a create message viem can hash under the hub's domain", () => {
    const typed = createMandateTypedData({
      domain: hubDomain({ name: "Hub", chainId: 143, address: "0x00000000000000000000000000000000000000dd" }),
      payer: "0x00000000000000000000000000000000000000cc",
      terms,
      nonce: 1n,
      deadline: 2n,
    });
    expect(typed.primaryType).toBe("Mandate");
    expect(hashTypedData(typed)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("permitTypedData", () => {
  it("signs AUSD under its Agora Dollar domain, not its token name", () => {
    const typed = permitTypedData({
      token: MAINNET_AUSD,
      chainId: 143,
      owner: "0x00000000000000000000000000000000000000cc",
      spender: "0x00000000000000000000000000000000000000dd",
      value: 1n,
      nonce: 0n,
      deadline: 1n,
    });
    expect(typed.domain.name).toBe("Agora Dollar");
    expect(typed.domain.version).toBe("1");
  });

  it("signs a vault's shares under a domain of only the chain and the vault, when that is its domain", () => {
    // Morpho's August USDC V2 vault on Monad Mainnet, whose DOMAIN_SEPARATOR() returns this value.
    const vault = "0x80017bF0f793EBbE9679Cd61ff0e395B62CAbB59";
    const typed = permitTypedData({
      token: { address: vault, permit: {} },
      chainId: 143,
      owner: "0x00000000000000000000000000000000000000cc",
      spender: "0x00000000000000000000000000000000000000dd",
      value: 1n,
      nonce: 0n,
      deadline: 1n,
    });
    expect(typed.domain).toEqual({ chainId: 143, verifyingContract: vault });
    expect(domainSeparator({ domain: typed.domain })).toBe("0x65e2e30aa3ac39cda9529e2ac6091f2b30d605611051e23e72a5715d9d29ec9d");
  });
});

describe("helpers", () => {
  it("draws distinct 256-bit nonces", () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a).not.toBe(b);
    expect(a < 2n ** 256n).toBe(true);
  });

  it("pads a ref to 32 bytes and refuses a longer one", () => {
    expect(refFromString("ab")).toBe(`0x6162${"0".repeat(60)}`);
    expect(() => refFromString("x".repeat(33))).toThrow(RangeError);
  });
});
