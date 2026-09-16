import type { MandateView } from "@weir/shared";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { checkoutFor, fakeApi, fakeChain, fakeDeps, MERCHANT, NOW, periodicMandate } from "../test/fixtures.js";
import { actionDryRun, prepareAction, relayAction, signAction } from "./actions.js";
import { summarize } from "./list.js";
import { summarizePlan } from "./plan.js";
import { renderAction, renderFaucet, renderList, renderPlan, renderSavings, renderSubscribe } from "./render.js";
import { moveDryRun, prepareMove, readSavings, savingsReport } from "./savings.js";
import { localSigner } from "./signer.js";
import { dryRunReport, installedReport, prepareInstall } from "./subscribe.js";
import { dateLong, durationPhrase, fromNow, periodPhrase, pricePhrase } from "./words.js";

const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

describe("words", () => {
  it("reads prices the way the checkout does", () => {
    expect(pricePhrase({ mode: "periodic", amount: "9990000", period: 2_592_000 })).toBe("$9.99 every month");
    expect(pricePhrase({ mode: "periodic", amount: "5000000", period: 1_209_600 })).toBe("$5.00 every 2 weeks");
    expect(pricePhrase({ mode: "streaming", amount: "100", period: 0 })).toBe("$0.36 an hour, billed by the second");
    expect(pricePhrase({ mode: "streaming", amount: "1", period: 0 })).toBe("$0.000001 a second");
  });

  it("names periods, lengths, dates and distances in time", () => {
    expect(periodPhrase(604_800)).toBe("week");
    expect(durationPhrase(31_104_000)).toBe("12 months");
    expect(durationPhrase(31_536_000)).toBe("1 year");
    expect(dateLong(NOW, "UTC")).toBe("21 September 2026");
    expect(fromNow(NOW + 3 * 86_400, NOW)).toBe("in 3 days");
    expect(fromNow(NOW - 2 * 3_600, NOW)).toBe("2 hours ago");
    expect(fromNow(NOW + 30, NOW)).toBe("now");
  });
});

describe("plan", () => {
  it("spells out every term a payer agrees to", () => {
    const text = renderPlan(summarizePlan(checkoutFor(), 10143, NOW, "UTC"));
    expect(text).toBe(
      [
        "Studio Pro from Lumen Studio",
        "Unlimited projects, 4K exports and priority support",
        "",
        "  Price         $9.99 every month",
        "  First charge  $9.99 right after install",
        "  Limits        At most $119.88 in total",
        "  Term          12 months, ending 16 September 2027 if subscribed now",
        "  Pays with     tAUSD on Monad Testnet (0xf3066908dABe11f2e72F6887D9943eeb621a0Eb9)",
        `  Merchant      Lumen Studio, paid at ${MERCHANT}`,
        "  Savings       Can pay from Test AUSD Savings (stAUSD), earning 5.0% a year until each charge",
      ].join("\n"),
    );
  });

  it("describes trials, streams and a paused plan", () => {
    const trial = summarizePlan(checkoutFor({ trialDays: 7 }), 10143, NOW, "UTC");
    expect(trial.words.firstCharge).toBe("Free for 7 days; the first charge of $9.99 is on 28 September 2026");
    expect(trial.firstCharge).toBe("0");
    const stream = summarizePlan(checkoutFor({ mode: "streaming", period: 0, amount: "100", maxPerCharge: "5000000", maxTotal: "20000000" }), 10143, NOW, "UTC");
    expect(stream.words.limits).toBe("At most $5.00 in one charge and $20.00 in total");
    expect(stream.words.firstCharge).toBe("Billing starts at install, by the second while it runs");
    expect(renderPlan(summarizePlan(checkoutFor({ active: false }), 10143, NOW, "UTC"))).toContain("Not taking new subscribers: Lumen Studio has paused this plan.");
  });
});

describe("subscribe", () => {
  it("prints a dry run as the terms, then each payload in signing order", async () => {
    const deps = fakeDeps({ chain: fakeChain(10143, { balance: 0n }) });
    const text = renderSubscribe(dryRunReport(deps, await prepareInstall(deps, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address)));
    const lines = text.split("\n");
    expect(lines[0]).toBe("Dry run: nothing was signed or sent.");
    expect(text).toContain(`  Payer      ${payer.address}\n  Manager    ${payer.address} (the payer), which can pause, resume and stop it but never spend`);
    expect(text).toContain("  Pays from  balance, $0.00 of tAUSD now; the first charge is $9.99, which it does not cover yet");
    expect(text).toContain("1. Let Weir's hub draw up to $119.88 of tAUSD from this wallet, $119.88 of it for Studio Pro");
    expect(text).toContain('   EIP-712 Permit under "Test AUSD" version 1, chain 10143, contract 0xf3066908dABe11f2e72F6887D9943eeb621a0Eb9');
    expect(text).toContain("2. Subscribe to Studio Pro from Lumen Studio: $9.99 every month, at most $119.88 in total, until 16 September 2027");
    expect(text).toContain("       maxTotal      119880000");
    expect(lines.at(-1)).toBe("Then both go to POST http://localhost:8790/v1/relay/install, and the relayer pays the gas.");
  });

  it("prints a subscription that ran with its mandate, transaction and receipt link", async () => {
    const deps = fakeDeps();
    const plan = await prepareInstall(deps, { planRef: "pln_5xjqdh77j4gflgvy", fromSavings: false }, payer.address);
    const tx = `0x${"ab".repeat(32)}` as const;
    const text = renderSubscribe(installedReport(plan, { mandateId: "42", transaction: tx, explorerUrl: `https://testnet.monadvision.com/tx/${tx}` }));
    expect(text).toBe(
      [
        "Subscribed to Studio Pro from Lumen Studio: $9.99 every month.",
        "  Mandate      #42",
        `  Transaction  ${tx}`,
        `  Receipt      https://testnet.monadvision.com/tx/${tx}`,
        "The first charge of $9.99 happens in a moment. At most $119.88 in total, until 16 September 2027. Stop it any time with `mm weir stop 42`.",
      ].join("\n"),
    );
  });
});

const view = (overrides: Partial<MandateView>): MandateView => ({
  id: "3",
  payer: payer.address,
  merchant: MERCHANT,
  asset: "0xf3066908dABe11f2e72F6887D9943eeb621a0Eb9",
  assetSymbol: "tAUSD",
  vault: "0x0000000000000000000000000000000000000000",
  manager: payer.address,
  amount: "9990000",
  period: 2_592_000,
  nextChargeAt: NOW + 30 * 86_400,
  maxPerCharge: "9990000",
  maxTotal: "119880000",
  totalCharged: "9990000",
  expiresAt: NOW + 31_104_000,
  pausedAt: 0,
  status: "Active",
  standing: "Active",
  ref: "0x706c6e5f35786a71646837376a3467666c677679000000000000000000000000",
  plan: { id: "pln_5xjqdh77j4gflgvy", name: "Studio Pro", description: "", mode: "periodic", merchantName: "Lumen Studio" },
  createdAt: NOW - 86_400,
  createdTx: `0x${"cd".repeat(32)}`,
  ...overrides,
});

describe("list", () => {
  it("shows each mandate's standing, price, next charge and cap, with totals", () => {
    const report = summarize(
      payer.address,
      [
        view({ id: "9", standing: "Paused", status: "Active", period: 0, amount: "100", pausedAt: NOW - 60, totalCharged: "123456", maxTotal: "20000000", plan: undefined, vault: "0xe0cd535d298DAd5e228486a79A21176349825B8d" }),
        view({}),
        view({ id: "2", standing: "Cancelled", status: "Cancelled" }),
      ],
      NOW,
      10143,
      "UTC",
    );
    expect(renderList(report)).toBe(
      [
        `Mandates paid by ${payer.address} on Monad Testnet`,
        "",
        "#9    [Paused]    Mandate #9",
        "      $0.36 an hour, billed by the second, from savings. Paused, nothing is billed.",
        "      Paid $0.123456 of $20.00. Ends 16 September 2027.",
        "",
        "#3    [Active]    Studio Pro from Lumen Studio",
        "      $9.99 every month, from balance. Next charge 21 October 2026, in 30 days.",
        "      Paid $9.99 of $119.88. Ends 16 September 2027.",
        "",
        "#2    [Cancelled] Studio Pro from Lumen Studio",
        "      $9.99 every month, from balance. No more charges.",
        "      Paid $9.99 of $119.88. Ends 16 September 2027.",
        "",
        "3 mandates: 1 running, 1 paused. Paid so far: $20.10 in tAUSD.",
        "Next: $9.99 for Studio Pro from Lumen Studio, on 21 October 2026.",
      ].join("\n"),
    );
    expect(report.totals).toMatchObject({ mandates: 3, running: 1, paused: 1, paid: { tAUSD: "20103456" } });
    expect(report.mandates[1]).toMatchObject({ id: "3", nextChargeAt: NOW + 30 * 86_400, paysFrom: "balance" });
    expect(report.mandates[0]?.nextChargeAt).toBeUndefined();
  });

  it("says so when there are none", () => {
    expect(renderList(summarize(payer.address, [], NOW, 10143))).toBe(`No mandates paid by ${payer.address} on Monad Testnet yet.`);
  });
});

describe("actions", () => {
  it("prints what was done and what it means", async () => {
    const chain = fakeChain(10143, { mandates: new Map([[3n, periodicMandate({ payer: payer.address })]]) });
    const indexed = { mandates: [view({})], charges: [] };
    const deps = fakeDeps({ chain, api: fakeApi({ payer: indexed }) });
    const plan = await prepareAction(deps, { mandateId: 3n, verb: "stop" }, payer.address);
    const done = renderAction(await relayAction(deps, plan, await signAction(plan, localSigner(payer))));
    expect(done.split("\n")[0]).toBe("Stopped Studio Pro from Lumen Studio (mandate #3). Nothing more can be charged on it.");
    const dry = renderAction(actionDryRun(deps, plan));
    expect(dry).toContain("Would stop Studio Pro from Lumen Studio (mandate #3), signing as its payer:");
    expect(dry).toContain('   EIP-712 MandateAction under "Weir" version 1, chain 10143');
    expect(dry).toContain("     action     1");
  });
});

describe("savings and faucet", () => {
  it("prints balance and savings, and a dry-run move", async () => {
    const deps = fakeDeps({ chain: fakeChain(10143, { balance: 90_010_000n, saved: 10_000_000n }) });
    const state = await readSavings(deps, payer.address);
    expect(renderSavings(savingsReport(state))).toBe(
      [
        `Savings for ${payer.address} on Monad Testnet`,
        "",
        "tAUSD: Test AUSD Savings (stAUSD), earning 5.0% a year",
        "  Balance  $90.01",
        "  Savings  $10.00",
      ].join("\n"),
    );
    const dry = renderSavings(moveDryRun(deps, state, await prepareMove(deps, state, { direction: "deposit", amount: 5_000_000n })));
    expect(dry).toContain("Would move $5.00 of tAUSD into savings.");
    expect(dry).toContain("Then it goes to POST http://localhost:8790/v1/relay/savings, and the relayer pays the gas.");
  });

  it("prints what the faucet sent", () => {
    const tx = `0x${"ab".repeat(32)}` as const;
    expect(renderFaucet({ chainId: 10143, address: payer.address, asset: "0xf3066908dABe11f2e72F6887D9943eeb621a0Eb9", amount: "100000000", transaction: tx, explorerUrl: `https://testnet.monadvision.com/tx/${tx}` })).toBe(
      [
        `Sent $100.00 in test dollars to ${payer.address} on Monad Testnet.`,
        "  Token        0xf3066908dABe11f2e72F6887D9943eeb621a0Eb9",
        `  Transaction  ${tx}`,
        `  Receipt      https://testnet.monadvision.com/tx/${tx}`,
      ].join("\n"),
    );
  });
});
