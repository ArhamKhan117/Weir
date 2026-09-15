import type { ActionRequest, InstallRequest, SavingsRequest, SignedPermit, WireTerms } from "@weir/shared";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { fakeApi, fakeChain, fakeDeps, HUB, periodicMandate, ROUTER, VAULT } from "../test/fixtures.js";
import { actionDryRun, actionRequest, prepareAction, relayAction, signAction } from "./actions.js";
import { prepareMove, readSavings, relayMove, savingsRequest, signMove } from "./savings.js";
import { localSigner } from "./signer.js";
import { dryRunReport, install, installRequest, prepareInstall, signInstall } from "./subscribe.js";

const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const SIG = `0x${"11".repeat(65)}` as const;

// The field lists the API's strict body readers accept (`apps/api/src/relay/requests.ts`); a body
// with any other field is refused with a 400.
const INSTALL_FIELDS = ["permit", "payer", "terms", "nonce", "deadline", "signature"] satisfies (keyof InstallRequest)[];
const SAVINGS_INSTALL_FIELDS = [...INSTALL_FIELDS, "backupPermit"] satisfies (keyof InstallRequest)[];
const PERMIT_FIELDS = ["token", "owner", "value", "deadline", "signature"] satisfies (keyof SignedPermit)[];
const TERMS_FIELDS = [
  "merchant",
  "asset",
  "vault",
  "manager",
  "amount",
  "period",
  "startAt",
  "maxPerCharge",
  "maxTotal",
  "expiresAt",
  "ref",
] satisfies (keyof WireTerms)[];
const ACTION_FIELDS = ["mandateId", "action", "signer", "nonce", "deadline", "signature"] satisfies (keyof ActionRequest)[];
const SAVINGS_FIELDS = ["direction", "owner", "asset", "amount", "maxShares", "deadline", "signature"] satisfies (keyof SavingsRequest)[];

const keys = (value: object) => Object.keys(value).sort();

describe("the install body", () => {
  it("carries exactly the fields the API reads, amounts as decimal strings and times as numbers", async () => {
    const plan = await prepareInstall(fakeDeps(), { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address);
    const body: InstallRequest = installRequest(plan, SIG, SIG);
    expect(keys(body)).toEqual([...INSTALL_FIELDS].sort());
    expect(keys(body.permit ?? {})).toEqual([...PERMIT_FIELDS].sort());
    expect(keys(body.terms)).toEqual([...TERMS_FIELDS].sort());
    expect(body.terms).toMatchObject({ amount: "9990000", maxPerCharge: "9990000", maxTotal: "119880000", period: 2_592_000, startAt: 0 });
    expect(typeof body.terms.expiresAt).toBe("number");
    expect(body.nonce).toMatch(/^\d+$/);
    expect(body.permit).toMatchObject({ token: plan.permit.token, owner: payer.address, value: "119880000" });
    expect(body.payer).toBe(payer.address);
    // The body survives JSON unchanged: nothing in it is a bigint.
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it("is what signing produces, and what the API is sent", async () => {
    const api = fakeApi({});
    const deps = fakeDeps({ api });
    const plan = await prepareInstall(deps, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address);
    const signed = await signInstall(plan, localSigner(payer));
    const installed = await install(deps, plan, signed);
    expect(api.calls.install).toEqual([signed]);
    expect(installed).toEqual({
      mandateId: "42",
      transaction: `0x${"ab".repeat(32)}`,
      explorerUrl: `https://testnet.monadvision.com/tx/0x${"ab".repeat(32)}`,
    });
  });

  it("shows a dry run the same body with placeholders where the signatures go", async () => {
    const deps = fakeDeps();
    const plan = await prepareInstall(deps, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address);
    const report = dryRunReport(deps, plan);
    expect(report.request?.url).toBe("http://localhost:8790/v1/relay/install");
    const body = report.request?.body as Record<string, unknown>;
    expect(keys(body)).toEqual([...INSTALL_FIELDS].sort());
    expect(body["signature"]).toBe("<the wallet's mandate signature>");
    expect((body["permit"] as Record<string, unknown>)["signature"]).toBe("<the wallet's permit signature>");
    expect(report.signatures?.map((signature) => signature.what)).toEqual(["permit", "mandate"]);
    // Typed data in a report is plain JSON, which JSON.stringify would refuse if a bigint were left.
    expect(() => JSON.stringify(report)).not.toThrow();
    expect((report.signatures?.[0]?.typedData as { message: { value: string } }).message.value).toBe("119880000");
  });

  it("from savings, carries a backup permit on the asset, signed second, for the same cap", async () => {
    const api = fakeApi({});
    const deps = fakeDeps({ api });
    const plan = await prepareInstall(deps, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: true }, payer.address);
    const signed = await signInstall(plan, localSigner(payer));
    expect(keys(signed)).toEqual([...SAVINGS_INSTALL_FIELDS].sort());
    expect(keys(signed.backupPermit ?? {})).toEqual([...PERMIT_FIELDS].sort());
    expect(signed.backupPermit).toMatchObject({ token: plan.terms.asset, owner: payer.address, value: "119880000" });
    expect(signed.permit?.token).toBe(VAULT);

    const report = dryRunReport(deps, plan);
    expect(report.signatures?.map((signature) => signature.what)).toEqual(["permit", "backupPermit", "mandate"]);
    const body = report.request?.body as Record<string, unknown>;
    expect((body["backupPermit"] as Record<string, unknown>)["signature"]).toBe("<the wallet's backup permit signature>");
  });

  it("from the balance, carries no backup permit", async () => {
    const plan = await prepareInstall(fakeDeps(), { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address);
    expect(plan.backup).toBeUndefined();
    expect(installRequest(plan, SIG, SIG, SIG).backupPermit).toBeUndefined();
  });

  it("refuses to sign with a wallet other than the payer it was built for", async () => {
    const plan = await prepareInstall(fakeDeps(), { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address);
    const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    await expect(signInstall(plan, localSigner(other))).rejects.toMatchObject({ code: "SIGNING_FAILED" });
  });
});

describe("the action body", () => {
  it("names the hub's action, the signer, and a decimal nonce", async () => {
    const api = fakeApi({});
    const chain = fakeChain(10143, { mandates: new Map([[3n, periodicMandate({ payer: payer.address })]]) });
    const deps = fakeDeps({ api, chain });
    const plan = await prepareAction(deps, { mandateId: 3n, verb: "stop" }, payer.address);
    const body: ActionRequest = actionRequest(plan, SIG);
    expect(keys(body)).toEqual([...ACTION_FIELDS].sort());
    expect(body).toMatchObject({ mandateId: "3", action: "cancel", signer: payer.address });
    expect(body.nonce).toMatch(/^\d+$/);

    const report = await relayAction(deps, plan, await signAction(plan, localSigner(payer)));
    expect(api.calls.action).toHaveLength(1);
    expect(report).toMatchObject({ dryRun: false, mandateId: "3", verb: "stop", actionCode: 1, role: "payer" });

    const dry = actionDryRun(deps, plan);
    expect(dry.request?.url).toBe("http://localhost:8790/v1/relay/action");
    expect((dry.request?.body as Record<string, unknown>)["signature"]).toBe("<the wallet's signature>");
  });
});

describe("the savings body", () => {
  it("moves in with a permit on the asset and no share cap", async () => {
    const api = fakeApi({});
    const deps = fakeDeps({ api });
    const state = await readSavings(deps, payer.address);
    const plan = await prepareMove(deps, state, { direction: "deposit", amount: 5_000_000n });
    const body: SavingsRequest = savingsRequest(plan, SIG);
    expect(keys(body)).toEqual(SAVINGS_FIELDS.filter((field) => field !== "maxShares").sort());
    expect(body).toMatchObject({ direction: "deposit", owner: payer.address, amount: "5000000" });

    const report = await relayMove(deps, plan, await signMove(plan, localSigner(payer)));
    expect(api.calls.savings).toHaveLength(1);
    expect(report.move).toMatchObject({ dryRun: false, direction: "deposit", amount: "5000000" });
  });

  it("moves out with the share cap the permit allows", async () => {
    const deps = fakeDeps({ chain: fakeChain(10143, { saved: 9_000_000n }) });
    const state = await readSavings(deps, payer.address);
    const plan = await prepareMove(deps, state, { direction: "withdraw", amount: 3_000_000n });
    const body = savingsRequest(plan, SIG);
    expect(keys(body)).toEqual([...SAVINGS_FIELDS].sort());
    expect(body).toMatchObject({ direction: "withdraw", amount: "3000000", maxShares: "3000000" });
    expect(plan.router).toBe(ROUTER);
    expect(plan.account.vault).toBe(VAULT);
  });
});

describe("the hub it all goes to", () => {
  it("is the one the API names, not one this build remembers", async () => {
    const other = "0x00000000000000000000000000000000000000dD";
    const chain = fakeChain(10143, { mandates: new Map([[3n, periodicMandate({ payer: payer.address })]]) });
    const deps = fakeDeps({ api: fakeApi({ health: { chainId: 10143, hub: other } }), chain });
    const plan = await prepareAction(deps, { mandateId: 3n, verb: "stop" }, payer.address);
    expect(plan.hub).toBe(other);
    expect(plan.hub).not.toBe(HUB);
  });
});
