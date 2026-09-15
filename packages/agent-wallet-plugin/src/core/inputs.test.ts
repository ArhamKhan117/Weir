import { describe, expect, it } from "vitest";

import { parseAddress, parseAmount, parseMandateId, parsePlanRef } from "./inputs.js";
import { chainOf, DEFAULT_API_URL, resolveSettings } from "./settings.js";

describe("parsePlanRef", () => {
  it("takes a bare plan id", () => {
    expect(parsePlanRef("pln_5xjqdh77j4gflgvy")).toBe("pln_5xjqdh77j4gflgvy");
    expect(parsePlanRef("  pln_5xjqdh77j4gflgvy \n")).toBe("pln_5xjqdh77j4gflgvy");
  });

  it("finds the plan id in a checkout link, whatever the host, query or fragment", () => {
    expect(parsePlanRef("https://weir.example/c/pln_5xjqdh77j4gflgvy")).toBe("pln_5xjqdh77j4gflgvy");
    expect(parsePlanRef("http://localhost:5173/c/pln_5xjqdh77j4gflgvy/")).toBe("pln_5xjqdh77j4gflgvy");
    expect(parsePlanRef("https://weir.example/c/pln_5xjqdh77j4gflgvy?devkey=1#terms")).toBe("pln_5xjqdh77j4gflgvy");
    expect(parsePlanRef("https://weir.example/app/c/pln_5xjqdh77j4gflgvy")).toBe("pln_5xjqdh77j4gflgvy");
  });

  it("finds it in the API's own checkout URL", () => {
    expect(parsePlanRef("http://localhost:8790/v1/checkout/pln_5xjqdh77j4gflgvy")).toBe("pln_5xjqdh77j4gflgvy");
  });

  it("refuses anything else, saying what a plan id looks like", () => {
    for (const bad of ["", "pln_short", "PLN_5XJQDH77J4GFLGVY", "pln_5xjqdh77j4gflgv1", "https://weir.example/p/pln_5xjqdh77j4gflgvy", "ftp://x/c/pln_5xjqdh77j4gflgvy", "Studio Pro"]) {
      expect(() => parsePlanRef(bad), bad).toThrow(expect.objectContaining({ code: "INVALID_INPUT", message: expect.stringContaining("not a Weir checkout link or plan id") }));
    }
  });
});

describe("parseMandateId", () => {
  it("takes a positive whole number, with or without #", () => {
    expect(parseMandateId("12")).toBe(12n);
    expect(parseMandateId("#7")).toBe(7n);
  });

  it("refuses zero, negatives, decimals and words", () => {
    for (const bad of ["0", "-1", "1.5", "twelve", "", "012"]) {
      expect(() => parseMandateId(bad), bad).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });
});

describe("parseAmount", () => {
  it("reads dollars exactly", () => {
    expect(parseAmount("25", "--in")).toBe(25_000_000n);
    expect(parseAmount("$12.50", "--in")).toBe(12_500_000n);
    expect(parseAmount("0.000001", "--out")).toBe(1n);
  });

  it("refuses zero and anything that is not an amount, naming the flag", () => {
    expect(() => parseAmount("0", "--in")).toThrow(expect.objectContaining({ message: "--in must be more than zero" }));
    expect(() => parseAmount("ten", "--out")).toThrow(expect.objectContaining({ message: '--out "ten" is not a dollar amount' }));
    expect(() => parseAmount("1.0000001", "--in")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});

describe("parseAddress", () => {
  it("checksums a valid address", () => {
    expect(parseAddress("0x4e80fa4ad069245b976ad4fd4ff1d8f94965af8c", "--payer")).toBe("0x4e80fA4AD069245b976ad4FD4Ff1d8f94965aF8C");
  });

  it("refuses a bad checksum and a non-address", () => {
    expect(() => parseAddress("0x4E80fA4AD069245b976ad4FD4Ff1d8f94965aF8C", "--payer")).toThrow(expect.objectContaining({ message: expect.stringContaining("invalid checksum") }));
    expect(() => parseAddress("0x1234", "--payer")).toThrow(expect.objectContaining({ message: '--payer "0x1234" is not an address' }));
  });
});

describe("settings", () => {
  it("takes the API from --api, then WEIR_API_URL, then the local default", () => {
    expect(resolveSettings({}, {}).apiUrl).toBe(DEFAULT_API_URL);
    expect(resolveSettings({}, { WEIR_API_URL: "https://api.weir.example/" }).apiUrl).toBe("https://api.weir.example");
    expect(resolveSettings({ api: "http://10.0.0.2:8790" }, { WEIR_API_URL: "https://api.weir.example" }).apiUrl).toBe("http://10.0.0.2:8790");
  });

  it("refuses a URL that is not http, naming where it came from", () => {
    expect(() => resolveSettings({ api: "localhost:8790" }, {})).toThrow(expect.objectContaining({ message: expect.stringContaining("--api") }));
    expect(() => resolveSettings({}, { WEIR_API_URL: "not a url" })).toThrow(expect.objectContaining({ message: expect.stringContaining("WEIR_API_URL") }));
  });

  it("reads MONAD_RPC_URL and MONAD_CHAIN_ID, refusing a chain that is not Monad", () => {
    expect(resolveSettings({}, { MONAD_RPC_URL: "https://rpc.example", MONAD_CHAIN_ID: "10143" })).toEqual({
      apiUrl: DEFAULT_API_URL,
      rpcUrl: "https://rpc.example",
      expectedChainId: 10143,
    });
    expect(() => resolveSettings({}, { MONAD_CHAIN_ID: "1" })).toThrow(expect.objectContaining({ message: expect.stringContaining("not a Monad network") }));
  });

  it("refuses an API on another chain than MONAD_CHAIN_ID, and one not on Monad at all", () => {
    const settings = resolveSettings({}, { MONAD_CHAIN_ID: "143" });
    expect(chainOf(143, settings)).toBe(143);
    expect(() => chainOf(10143, settings)).toThrow(expect.objectContaining({ code: "CHAIN_MISMATCH" }));
    expect(() => chainOf(1, resolveSettings({}, {}))).toThrow(expect.objectContaining({ code: "UNSUPPORTED_CHAIN" }));
  });
});
