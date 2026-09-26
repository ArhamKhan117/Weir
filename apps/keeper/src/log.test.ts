import { BaseError } from "viem";
import { describe, expect, it } from "vitest";
import { describeError } from "./log.js";

describe("describeError", () => {
  it("keeps an RPC failure to one line, with the node's own reason", () => {
    const rpc = new BaseError("RPC Request failed.", { details: "Signer had insufficient balance" });
    const error = new BaseError("Missing or invalid parameters.\nDouble check you have provided the correct parameters.", {
      cause: rpc,
    });
    expect(describeError(error)).toBe("Missing or invalid parameters: Signer had insufficient balance");
  });

  it("walks the causes of a plain error", () => {
    expect(describeError(new Error("reading the cursor failed", { cause: new Error("EACCES") }))).toBe(
      "reading the cursor failed: EACCES",
    );
    expect(describeError("timeout")).toBe("timeout");
  });
});
