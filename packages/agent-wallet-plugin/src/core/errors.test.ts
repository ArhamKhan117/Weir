import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { checkoutFor, fakeApi, fakeChain, fakeDeps, periodicMandate } from "../test/fixtures.js";
import { checkAllowed, prepareAction } from "./actions.js";
import { createApi } from "./api.js";
import { describeRefusal } from "./errors.js";
import { requestTestDollars } from "./faucet.js";
import { prepareMove, readSavings } from "./savings.js";
import { prepareInstall, requireFunds } from "./subscribe.js";

const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

describe("describeRefusal", () => {
  it("names the hub's custom error and its reason", () => {
    expect(describeRefusal("MandateExpired(1790000000, 1790000100): the mandate has expired")).toEqual({
      code: "HUB_REFUSED",
      message: "the hub refused it: MandateExpired (the mandate has expired)",
      hint: "The mandate has passed its end date, so there is nothing left to change.",
    });
    expect(describeRefusal("NotStreaming()").message).toBe("the hub refused it: NotStreaming");
  });

  it("blames the token for a refused permit", () => {
    const refusal = describeRefusal("ERC2612InvalidSigner(0x00, 0x01): the permit is not signed by its owner");
    expect(refusal.code).toBe("TOKEN_REFUSED");
    expect(refusal.message).toBe("the token refused the permit: ERC2612InvalidSigner (the permit is not signed by its owner)");
  });

  it("passes a sentence through when nothing decoded", () => {
    expect(describeRefusal("the call reverts without a reason").message).toBe("the hub refused it: the call reverts without a reason");
    expect(describeRefusal("the transaction was mined and reverted (transaction 0xabc)").message).toBe(
      "the hub refused it: the transaction was mined and reverted (transaction 0xabc)",
    );
  });
});

function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  return async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

describe("API failures", () => {
  it("names a refusal on chain", async () => {
    const api = createApi("http://api.test", answering(422, { error: { code: "rejected_on_chain", message: "MandateIsCancelled(): the mandate is cancelled" } }));
    await expect(api.action({} as never)).rejects.toMatchObject({ code: "HUB_REFUSED", message: "the hub refused it: MandateIsCancelled (the mandate is cancelled)" });
  });

  it("says a plan does not exist, and where it looked", async () => {
    const api = createApi("http://api.test", answering(404, { error: { code: "not_found", message: "No plan pln_aaaaaaaaaaaaaaaa" } }));
    await expect(api.checkout("pln_aaaaaaaaaaaaaaaa")).rejects.toMatchObject({ code: "PLAN_NOT_FOUND", message: "No plan pln_aaaaaaaaaaaaaaaa at the Weir API at http://api.test" });
  });

  it("says when to retry a rate limit", async () => {
    const api = createApi("http://api.test", answering(429, { error: { code: "rate_limited", message: "Too many installs for this payer; try again shortly" } }, { "retry-after": "12" }));
    await expect(api.install({} as never)).rejects.toMatchObject({ code: "RATE_LIMITED", hint: "Wait 12 seconds and try again." });
  });

  it("reports a bad request, a missing relayer and a receipt that did not come", async () => {
    await expect(createApi("http://api.test", answering(400, { error: { code: "bad_request", message: "deadline has passed" } })).action({} as never)).rejects.toMatchObject({
      code: "API_REFUSED",
      message: "The Weir API refused the request: deadline has passed",
    });
    await expect(createApi("http://api.test", answering(503, { error: { code: "not_configured", message: "The relayer is not configured on this server" } })).savings({} as never)).rejects.toMatchObject({
      code: "RELAYER_UNAVAILABLE",
    });
    await expect(createApi("http://api.test", answering(504, { error: { code: "internal", message: "transaction 0x12 was sent and has no receipt yet" } })).install({} as never)).rejects.toMatchObject({
      code: "RECEIPT_PENDING",
    });
  });

  it("says where it looked when nothing answers, and when the answer is not the API", async () => {
    const down = createApi("http://127.0.0.1:9", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(down.health()).rejects.toMatchObject({ code: "API_UNREACHABLE", message: "The Weir API at http://127.0.0.1:9 could not be reached" });
    const web = createApi("http://localhost:5173", answering(200, "<!doctype html><html></html>"));
    await expect(web.health()).rejects.toMatchObject({ code: "API_ERROR", hint: expect.stringContaining("not the web app") });
  });

  it("still reads the chain from a health answer that reports a database outage", async () => {
    const api = createApi("http://api.test", answering(503, { ok: false, chainId: 10143, hub: "0x6CfD37e32c51d87c20362EeD0C6cc8908855045D", database: false }));
    await expect(api.health()).resolves.toEqual({ chainId: 10143, hub: "0x6CfD37e32c51d87c20362EeD0C6cc8908855045D" });
  });
});

describe("subscribe refuses before signing", () => {
  it("a paused plan", async () => {
    const deps = fakeDeps({ api: fakeApi({ checkout: checkoutFor({ active: false }) }) });
    await expect(prepareInstall(deps, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address)).rejects.toMatchObject({
      code: "PLAN_INACTIVE",
      message: "Lumen Studio has paused Studio Pro and is not taking new subscribers",
    });
  });

  it("savings where the asset has none", async () => {
    const deps = fakeDeps({ api: fakeApi({ checkout: checkoutFor({}, { savingsVault: undefined }) }) });
    await expect(prepareInstall(deps, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: true }, payer.address)).rejects.toMatchObject({ code: "NO_SAVINGS" });
  });

  it("an API on another chain than MONAD_CHAIN_ID", async () => {
    const deps = fakeDeps({ settings: { expectedChainId: 143 } });
    await expect(prepareInstall(deps, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address)).rejects.toMatchObject({ code: "CHAIN_MISMATCH" });
  });

  it("a first charge the wallet cannot cover, pointing at the faucet on Testnet", async () => {
    const deps = fakeDeps({ chain: fakeChain(10143, { balance: 1_000_000n }) });
    const plan = await prepareInstall(deps, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address);
    expect(() => requireFunds(plan)).toThrow(
      expect.objectContaining({
        code: "INSUFFICIENT_FUNDS",
        message: "This wallet's balance holds $1.00 of tAUSD, and the first charge is $9.99",
        hint: "Get test dollars with `mm weir faucet`, then subscribe again.",
      }),
    );
  });
});

describe("actions refuse before signing", () => {
  const title = "Studio Pro from Lumen Studio";

  it("pause or resume on a periodic mandate, saying they apply to streams only", () => {
    for (const verb of ["pause", "resume"] as const) {
      expect(() => checkAllowed(verb, periodicMandate(), title)).toThrow(
        expect.objectContaining({
          code: "NOT_A_STREAM",
          message: "Pause and resume apply to per-second streams only; Studio Pro from Lumen Studio (mandate #3) is a periodic mandate, $9.99 every month",
          hint: "Stop it instead with `mm weir stop 3`.",
        }),
      );
    }
    expect(() => checkAllowed("stop", periodicMandate(), title)).not.toThrow();
  });

  it("anything on a stopped mandate, a second pause, and a resume of a running stream", () => {
    expect(() => checkAllowed("stop", periodicMandate({ status: "Cancelled" }), title)).toThrow(expect.objectContaining({ code: "ALREADY_STOPPED" }));
    const stream = periodicMandate({ period: 0, amount: 100n });
    expect(() => checkAllowed("pause", { ...stream, pausedAt: 5n }, title)).toThrow(expect.objectContaining({ code: "ALREADY_PAUSED" }));
    expect(() => checkAllowed("resume", stream, title)).toThrow(expect.objectContaining({ code: "NOT_PAUSED" }));
  });

  it("a mandate that does not exist, or is not this wallet's", async () => {
    await expect(prepareAction(fakeDeps(), { mandateId: 99n, verb: "stop" }, payer.address)).rejects.toMatchObject({ code: "MANDATE_NOT_FOUND" });
    const someoneElses = fakeChain(10143, { mandates: new Map([[3n, periodicMandate()]]) });
    await expect(prepareAction(fakeDeps({ chain: someoneElses }), { mandateId: 3n, verb: "stop" }, payer.address)).rejects.toMatchObject({
      code: "NOT_YOURS",
      message: expect.stringContaining("is neither its payer nor its manager"),
    });
  });
});

describe("savings refuses before signing", () => {
  it("moving more than there is, either way", async () => {
    const deps = fakeDeps({ chain: fakeChain(10143, { balance: 2_000_000n, saved: 1_000_000n }) });
    const state = await readSavings(deps, payer.address);
    await expect(prepareMove(deps, state, { direction: "deposit", amount: 5_000_000n })).rejects.toMatchObject({
      code: "INSUFFICIENT_FUNDS",
      message: "Cannot move $5.00 into savings: the wallet holds $2.00 of tAUSD",
    });
    await expect(prepareMove(deps, state, { direction: "withdraw", amount: 5_000_000n })).rejects.toMatchObject({
      code: "INSUFFICIENT_FUNDS",
      message: "Cannot move $5.00 out of savings: they hold $1.00 of tAUSD",
    });
  });

  it("an asset without savings, and a network without a router", async () => {
    const deps = fakeDeps();
    const state = await readSavings(deps, payer.address);
    await expect(prepareMove(deps, state, { direction: "deposit", amount: 1n, asset: "USDC" })).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Weir offers no savings in USDC" });
    await expect(prepareMove(deps, { ...state, router: undefined } as never, { direction: "deposit", amount: 1n })).rejects.toMatchObject({ code: "NO_SAVINGS" });
    expect((await prepareMove(deps, state, { direction: "deposit", amount: 1n, asset: "tausd" })).account.assetSymbol).toBe("tAUSD");
  });
});

describe("faucet", () => {
  it("refuses on Mainnet before asking", async () => {
    const deps = fakeDeps({ api: fakeApi({ health: { chainId: 143, hub: "0x6CfD37e32c51d87c20362EeD0C6cc8908855045D" } }) });
    await expect(requestTestDollars(deps, payer.address)).rejects.toMatchObject({ code: "NOT_TESTNET" });
  });
});
