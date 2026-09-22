import { describe, expect, it } from "vitest";

import { parseAction, parseInstall, parseSetManager } from "../relay/requests.js";
import { ApiHttpError } from "./errors.js";
import {
  MAX_UINT96,
  readAddress,
  readDeadline,
  readInteger,
  readObject,
  readSignature,
  readUnits,
} from "./validate.js";

const NOW = 1_800_000_000;
const LOWER = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

function rejects(run: () => unknown, pattern: RegExp): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiHttpError);
  expect((caught as ApiHttpError).status).toBe(400);
  expect((caught as ApiHttpError).code).toBe("bad_request");
  expect((caught as ApiHttpError).message).toMatch(pattern);
}

describe("addresses", () => {
  it("checksums a single-case address and keeps a valid checksum", () => {
    expect(readAddress(LOWER, "a")).toBe(CHECKSUMMED);
    expect(readAddress(LOWER.toUpperCase().replace("0X", "0x"), "a")).toBe(CHECKSUMMED);
    expect(readAddress(CHECKSUMMED, "a")).toBe(CHECKSUMMED);
  });

  it("refuses a mixed-case address with a bad checksum, and anything not 20 bytes", () => {
    rejects(() => readAddress(CHECKSUMMED.replace("aAeb", "AAeb"), "payer"), /payer has an invalid EIP-55 checksum/);
    rejects(() => readAddress("0x1234", "payer"), /payer must be a 20-byte 0x address/);
    rejects(() => readAddress(42, "payer"), /payer must be a 20-byte/);
  });
});

describe("units", () => {
  it("reads decimal strings within uint96", () => {
    expect(readUnits("0", "x")).toBe(0n);
    expect(readUnits(MAX_UINT96.toString(), "x")).toBe(MAX_UINT96);
  });

  it("refuses numbers, negatives, decimals and values past uint96", () => {
    rejects(() => readUnits(5, "amount"), /amount must be a decimal string of base units/);
    rejects(() => readUnits("-1", "amount"), /decimal string/);
    rejects(() => readUnits("1.5", "amount"), /decimal string/);
    rejects(() => readUnits((MAX_UINT96 + 1n).toString(), "amount"), /at most/);
    rejects(() => readUnits("0", "amount", { min: 1n }), /at least 1/);
  });
});

describe("integers, deadlines, signatures, objects", () => {
  it("reads safe non-negative integers", () => {
    expect(readInteger(60, "period")).toBe(60);
    rejects(() => readInteger(1.5, "period"), /period must be an integer/);
    rejects(() => readInteger("60", "period"), /integer/);
    rejects(() => readInteger(-1, "period"), /at least 0/);
  });

  it("wants deadlines strictly in the future", () => {
    expect(readDeadline(NOW + 1, "deadline", NOW)).toBe(NOW + 1);
    rejects(() => readDeadline(NOW, "deadline", NOW), /deadline has passed/);
  });

  it("bounds signature length", () => {
    const sig = `0x${"ab".repeat(65)}`;
    expect(readSignature(sig, "s", { min: 65, max: 65 })).toBe(sig);
    rejects(() => readSignature(`0x${"ab".repeat(64)}`, "s", { min: 65, max: 65 }), /s must be 65 bytes/);
    rejects(() => readSignature("0xabc", "s", { min: 1, max: 10 }), /s must be 0x hex/);
  });

  it("refuses unexpected keys", () => {
    rejects(() => readObject({ a: 1, b: 2 }, "body", ["a"]), /body has unexpected field b/);
    rejects(() => readObject([], "body", []), /must be a JSON object/);
  });
});

describe("relay bodies", () => {
  const terms = {
    merchant: CHECKSUMMED,
    asset: CHECKSUMMED,
    vault: "0x0000000000000000000000000000000000000000",
    manager: "0x0000000000000000000000000000000000000000",
    amount: "5000000",
    period: 2_592_000,
    startAt: 0,
    maxPerCharge: "5000000",
    maxTotal: "60000000",
    expiresAt: NOW + 86_400,
    ref: `0x${"00".repeat(32)}`,
  };
  const install = { payer: LOWER, terms, nonce: "1", deadline: NOW + 600, signature: `0x${"11".repeat(65)}` };

  it("reads an install into contract values", () => {
    const parsed = parseInstall(install, NOW);
    expect(parsed.payer).toBe(CHECKSUMMED);
    expect(parsed.terms.amount).toBe(5_000_000n);
    expect(parsed.terms.expiresAt).toBe(BigInt(NOW + 86_400));
    expect(parsed.permit).toBeUndefined();
  });

  it("names the nested field that is wrong", () => {
    rejects(() => parseInstall({ ...install, terms: { ...terms, maxTotal: (MAX_UINT96 + 1n).toString() } }, NOW), /terms\.maxTotal must be at most/);
    rejects(() => parseInstall({ ...install, terms: { ...terms, period: 2 ** 32 } }, NOW), /terms\.period must be at most/);
    rejects(() => parseInstall({ ...install, terms: { ...terms, extra: 1 } }, NOW), /terms has unexpected field extra/);
    rejects(() => parseInstall({ ...install, nonce: 1 }, NOW), /nonce must be a decimal string/);
    rejects(() => parseInstall({ ...install, deadline: NOW - 1 }, NOW), /deadline has passed/);
    rejects(() => parseInstall({ ...install, permit: { token: CHECKSUMMED, owner: LOWER, value: "1", deadline: NOW + 1, signature: "0x11" } }, NOW), /permit\.signature must be 65 bytes/);
    rejects(() => parseInstall({ terms, nonce: "1", deadline: NOW + 1, signature: "0x11" }, NOW), /payer is required/);
  });

  it("reads actions and manager changes", () => {
    const action = parseAction({ mandateId: "7", action: "pause", signer: LOWER, nonce: "9", deadline: NOW + 60, signature: "0x11" }, NOW);
    expect(action).toMatchObject({ mandateId: 7n, action: "pause", signer: CHECKSUMMED, nonce: 9n });
    rejects(() => parseAction({ mandateId: "0", action: "pause", signer: LOWER, nonce: "9", deadline: NOW + 60, signature: "0x11" }, NOW), /mandateId must be at least 1/);
    rejects(() => parseAction({ mandateId: "1", action: "charge", signer: LOWER, nonce: "9", deadline: NOW + 60, signature: "0x11" }, NOW), /action must be one of cancel, pause, resume/);
    expect(parseSetManager({ mandateId: "3", manager: LOWER, nonce: "1", deadline: NOW + 60, signature: "0x11" }, NOW).manager).toBe(CHECKSUMMED);
  });
});
