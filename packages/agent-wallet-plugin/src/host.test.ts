import { CommandError } from "@metamask/agent-wallet/plugin";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { toCommandError } from "./command.js";
import { WeirError } from "./core/errors.js";
import { prepareInstall, signInstall } from "./core/subscribe.js";
import { selectedAddress, signatureFrom, walletAddress, walletSigner, type HostContextLike } from "./host.js";
import { fakeDeps, fakeHost, fakeIo } from "./test/fixtures.js";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

describe("selectedAddress", () => {
  it("takes the selected wallet in the selected mode, by id, address or name", () => {
    const remoteWallets = [
      { id: "w1", address: A, name: "first" },
      { id: "w2", address: B, name: "second" },
    ];
    expect(selectedAddress({ remoteWallets, selectedWallet: { mode: "server", namespace: "evm", ref: { id: "w2" } } })).toBe(B);
    expect(selectedAddress({ remoteWallets, selectedWallet: { mode: "server", ref: { address: B.toUpperCase().replace("0X", "0x") } } })).toBe(B);
    expect(selectedAddress({ remoteWallets, selectedWallet: { mode: "server", ref: { name: "second" } } })).toBe(B);
  });

  it("falls back to the first EVM wallet of the mode, as the host does, and skips Solana", () => {
    expect(selectedAddress({ remoteWallets: [{ address: "So1ana", namespace: "solana" }, { address: A }], selectedWallet: { mode: "server", ref: { id: "gone" } } })).toBe(A);
    expect(selectedAddress({ remoteWallets: [{ address: A }], byokWallets: [{ address: C }], selectedWallet: { mode: "byok" } })).toBe(C);
    expect(selectedAddress({})).toBeUndefined();
  });
});

describe("walletAddress", () => {
  it("names the missing capability when the host refuses wallet-read", () => {
    const ctx = {
      get walletStateManager(): never {
        throw new CommandError("PERMISSION_DENIED", "Plugin 'weir:list' did not declare the 'wallet-read' capability.", "Re-install the plugin with the required permissions.");
      },
    } as HostContextLike;
    expect(() => walletAddress(ctx)).toThrow(expect.objectContaining({ code: "CAPABILITY_MISSING", message: expect.stringContaining("`wallet-read`") }));
  });

  it("says how to set a wallet up when there is none", () => {
    expect(() => walletAddress({ walletStateManager: { read: () => ({}) } })).toThrow(expect.objectContaining({ code: "WALLET_MISSING" }));
  });
});

describe("walletSigner", () => {
  it("signs through the executor as a typed-data request, opening it once for both signatures", async () => {
    let opened = 0;
    const host = fakeHost(account);
    const counting: HostContextLike = {
      ...host,
      walletExecutor: async (io, source) => {
        opened += 1;
        expect(source).toBe("weir:subscribe");
        return (await host.walletExecutor!(io, source));
      },
    };
    const address = walletAddress(host);
    expect(address).toBe(account.address);

    const plan = await prepareInstall(fakeDeps(), { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, address);
    const request = await signInstall(plan, walletSigner(counting, fakeIo, "weir:subscribe", plan.chainId, address));
    expect(opened).toBe(1);
    expect(host.jobs.map((job) => [job.kind, job.chainId, job.intent.action])).toEqual([
      ["typed-data", 10143, "sign"],
      ["typed-data", 10143, "sign"],
    ]);
    expect(host.jobs[1]?.intent.summary).toBe(plan.mandate.request.summary);
    expect(await recoverTypedDataAddress({ ...plan.mandate.request.typedData, signature: request.signature })).toBe(account.address);
    expect(await recoverTypedDataAddress({ ...plan.permit.request.typedData, signature: request.permit!.signature })).toBe(account.address);
  });

  it("refuses an answer with no signature, and passes the host's own errors through", async () => {
    const pending = fakeHost(account, { answer: async () => ({ kind: "signature", status: "AWAITING_MFA" }) });
    const signer = walletSigner(pending, fakeIo, "weir:stop", 10143, account.address);
    const request = { typedData: { domain: {}, types: {}, primaryType: "X", message: {} } as never, summary: "Stop mandate #3" };
    await expect(signer.signTypedData(request)).rejects.toMatchObject({
      code: "SIGNING_FAILED",
      message: 'The wallet did not sign "Stop mandate #3": it answered AWAITING_MFA',
      hint: expect.stringContaining("Approve it where the wallet asks"),
    });

    const denied = new CommandError("TX_DENIED", "The approval was denied on the paired device / registered email.", "Run it again.");
    const refusing = fakeHost(account, { answer: async () => Promise.reject(denied) });
    await expect(walletSigner(refusing, fakeIo, "weir:stop", 10143, account.address).signTypedData(request)).rejects.toBe(denied);
  });

  it("names wallet-submit when the executor is withheld", async () => {
    const ctx = {
      walletStateManager: fakeHost(account).walletStateManager,
      walletExecutor: async () => {
        throw new CommandError("PERMISSION_DENIED", "Plugin 'weir:stop' did not declare the 'wallet-submit' capability.", "Re-install.");
      },
    } as HostContextLike;
    const signer = walletSigner(ctx, fakeIo, "weir:stop", 10143, account.address);
    await expect(signer.signTypedData({ typedData: {} as never, summary: "x" })).rejects.toMatchObject({ code: "CAPABILITY_MISSING", message: expect.stringContaining("`wallet-submit`") });
  });

  it("adds a missing 0x to a signature", () => {
    const raw = "ab".repeat(65);
    expect(signatureFrom({ signature: raw, status: "SIGNED" }, "x")).toBe(`0x${raw}` as Hex);
  });
});

describe("the command boundary", () => {
  it("turns a plugin failure into the host's error with its code and hint, and leaves host errors alone", () => {
    const mapped = toCommandError(new WeirError("NOT_A_STREAM", "Pause and resume apply to per-second streams only", "Stop it instead."));
    expect(mapped).toBeInstanceOf(CommandError);
    expect(mapped).toMatchObject({ code: "NOT_A_STREAM", message: "Pause and resume apply to per-second streams only", hint: "Stop it instead." });
    const host = new CommandError("AUTH_FAILED", "Authentication failed", "Run `mm login`.");
    expect(toCommandError(host)).toBe(host);
    expect(toCommandError(new Error("boom"))).toMatchObject({ code: "UNEXPECTED", message: "boom" });
  });
});
