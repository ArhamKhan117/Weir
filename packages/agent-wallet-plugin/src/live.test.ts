/**
 * The whole plugin against a running Weir API on Monad Testnet, the way `mm weir` drives it, with
 * a fresh key standing in for the Agent Wallet.
 *
 * Every signature goes through the same host bridge the CLI uses: a `typed-data` request to the
 * wallet executor, put through the host's wire encoding, answered by a local account instead of
 * MetaMask's signer. A new account is funded by the faucet and never holds MON; the relayer pays
 * every transaction. It subscribes to a periodic plan, moves money into savings and back, installs
 * a per-second stream and pauses, resumes and stops it, and stops the subscription, reading each
 * result back from the chain and the API's index.
 *
 * A second case approves the API's paid demo endpoint over x402, pays requests with receipts alone,
 * and stops the meter.
 *
 * Opt in with `WEIR_LIVE_API=http://localhost:8790`, since it spends Testnet faucet dollars and the
 * relayer's gas; `WEIR_LIVE_PLAN` picks the periodic plan. It skips otherwise.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { prepareAction, relayAction, signAction, type Verb } from "./core/actions.js";
import { createDeps, type Deps } from "./core/deps.js";
import { requestTestDollars } from "./core/faucet.js";
import { listMandates } from "./core/list.js";
import { openMeter, paidFetch, prepareApproval, prepareMeterStop, signApproval, stopMeter } from "./core/meter.js";
import { prepareMove, readSavings, relayMove, signMove } from "./core/savings.js";
import { resolveSettings } from "./core/settings.js";
import { install, prepareInstall, requireFunds, signInstall } from "./core/subscribe.js";
import { walletSigner } from "./host.js";
import { fakeHost, fakeIo } from "./test/fixtures.js";

const apiUrl = process.env["WEIR_LIVE_API"];
const planId = process.env["WEIR_LIVE_PLAN"] ?? "pln_5xjqdh77j4gflgvy";

async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** Monad Testnet blocks are about a second apart; this lets at least one pass. */
const nextBlock = () => new Promise((resolve) => setTimeout(resolve, 3_000));

describe.skipIf(apiUrl === undefined)("the plugin against a live Weir API", () => {
  it(
    "subscribes, saves, streams, pauses, resumes and stops with signatures alone",
    async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const host = fakeHost(account);
      const deps: Deps = createDeps(resolveSettings({ api: apiUrl }, process.env));
      const signer = (commandId: string, chainId: number) => walletSigner(host, fakeIo, commandId, chainId, account.address);
      const receipts: string[] = [`payer ${account.address}`];
      const open = new Set<string>();

      const act = async (mandateId: string, verb: Verb) => {
        const plan = await prepareAction(deps, { mandateId: BigInt(mandateId), verb }, account.address);
        const report = await relayAction(deps, plan, await signAction(plan, signer(`weir:${verb}`, plan.chainId)));
        receipts.push(`${verb} #${mandateId} ${report.explorerUrl}`);
        if (verb === "stop") open.delete(mandateId);
        return report;
      };

      try {
        // Test dollars, and nothing else: the account never holds MON.
        const granted = await requestTestDollars(deps, account.address);
        receipts.push(`faucet ${granted.explorerUrl}`);
        const chain = deps.chain(granted.chainId);
        await until("the faucet's dollars", async () => ((await chain.balanceOf(granted.asset, account.address)) > 0n ? true : undefined));

        // Subscribe to the periodic plan, as `mm weir subscribe` does.
        const subscription = await prepareInstall(deps, { planRef: planId, fromSavings: false }, account.address);
        requireFunds(subscription);
        const installed = await install(deps, subscription, await signInstall(subscription, signer("weir:subscribe", subscription.chainId)));
        open.add(installed.mandateId);
        receipts.push(`subscribe #${installed.mandateId} ${installed.explorerUrl}`);
        const onChain = await chain.mandate(subscription.checkout.hub, BigInt(installed.mandateId));
        expect(onChain).toMatchObject({ payer: account.address, manager: account.address, status: "Active", period: subscription.terms.period });

        // The index catches up and lists it.
        const listed = await until("the index to list the subscription", async () => {
          const report = await listMandates(deps, account.address);
          return report.mandates.find((line) => line.id === installed.mandateId);
        });
        expect(listed).toMatchObject({ title: `${subscription.checkout.plan.name} from ${subscription.checkout.plan.merchant.name}`, paysFrom: "balance" });

        // A periodic mandate cannot be paused: refused before anything is signed.
        await expect(prepareAction(deps, { mandateId: BigInt(installed.mandateId), verb: "pause" }, account.address)).rejects.toMatchObject({ code: "NOT_A_STREAM" });

        // Savings in, then part of it back out.
        const state = await readSavings(deps, account.address);
        const into = await prepareMove(deps, state, { direction: "deposit", amount: 5_000_000n });
        const moved = await relayMove(deps, into, await signMove(into, signer("weir:savings", into.chainId)));
        receipts.push(`savings in ${moved.move?.explorerUrl}`);
        expect(BigInt(moved.accounts[0]?.saved ?? "0")).toBeGreaterThanOrEqual(4_999_999n);
        const outOf = await prepareMove(deps, await readSavings(deps, account.address), { direction: "withdraw", amount: 2_000_000n });
        const back = await relayMove(deps, outOf, await signMove(outOf, signer("weir:savings", outOf.chainId)));
        receipts.push(`savings out ${back.move?.explorerUrl}`);
        expect(BigInt(back.accounts[0]?.saved ?? "0")).toBeLessThan(BigInt(moved.accounts[0]?.saved ?? "0"));

        // A per-second stream on the same merchant, built from the plan with streaming terms.
        const streamingDeps: Deps = {
          ...deps,
          api: {
            ...deps.api,
            checkout: async (id) => {
              const real = await deps.api.checkout(id);
              return {
                ...real,
                plan: { ...real.plan, mode: "streaming", period: 0, amount: "100", trialDays: 0, maxPerCharge: "1000000", maxTotal: "2000000", termSeconds: 86_400 },
              };
            },
          },
        };
        const stream = await prepareInstall(streamingDeps, { planRef: planId, fromSavings: false }, account.address);
        const streaming = await install(deps, stream, await signInstall(stream, signer("weir:subscribe", stream.chainId)));
        open.add(streaming.mandateId);
        receipts.push(`stream #${streaming.mandateId} ${streaming.explorerUrl}`);

        // Pausing or stopping a running stream settles what it has accrued. The relayer estimates gas
        // at the latest block, so an action in the very second a stream starts or resumes is estimated
        // without that settlement and runs out of gas once it lands. Let a block pass first.
        await nextBlock();
        await act(streaming.mandateId, "pause");
        expect((await chain.mandate(stream.checkout.hub, BigInt(streaming.mandateId)))?.pausedAt).not.toBe(0n);
        await expect(prepareAction(deps, { mandateId: BigInt(streaming.mandateId), verb: "pause" }, account.address)).rejects.toMatchObject({ code: "ALREADY_PAUSED" });
        await act(streaming.mandateId, "resume");
        expect((await chain.mandate(stream.checkout.hub, BigInt(streaming.mandateId)))?.pausedAt).toBe(0n);
        await nextBlock();
        await act(streaming.mandateId, "stop");
        await act(installed.mandateId, "stop");
        expect((await chain.mandate(subscription.checkout.hub, BigInt(installed.mandateId)))?.status).toBe("Cancelled");
        await expect(prepareAction(deps, { mandateId: BigInt(installed.mandateId), verb: "stop" }, account.address)).rejects.toMatchObject({ code: "ALREADY_STOPPED" });

        // Ten signatures, every one through the host bridge's typed-data request.
        expect(host.jobs.map((job) => job.kind)).toEqual(Array(10).fill("typed-data"));
      } finally {
        // Leave nothing charging on a key that is about to be forgotten.
        for (const mandateId of open) {
          await nextBlock();
          await act(mandateId, "stop").catch((error: unknown) => receipts.push(`could not stop #${mandateId}: ${String(error)}`));
        }
        console.log(receipts.join("\n"));
      }
    },
    300_000,
  );

  it(
    "approves a paid API, pays its requests with receipts alone, and stops the meter",
    async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const host = fakeHost(account);
      const deps: Deps = createDeps(resolveSettings({ api: apiUrl }, process.env));
      const signer = (commandId: string, chainId: number) => walletSigner(host, fakeIo, commandId, chainId, account.address);
      const demo = `${apiUrl}/demo/fx?to=EUR`;
      const receipts: string[] = [`payer ${account.address}`];
      let meterId: string | undefined;

      try {
        const granted = await requestTestDollars(deps, account.address);
        const chain = deps.chain(granted.chainId);
        await until("the faucet's dollars", async () => ((await chain.balanceOf(granted.asset, account.address)) > 0n ? true : undefined));

        // `mm weir approve`: the demo's suggested caps, two signatures, one relayed transaction.
        const plan = await prepareApproval(deps, fetch, { url: demo }, account.address);
        const opened = await openMeter(fetch, plan, await signApproval(plan, signer("weir:approve", plan.offer.chainId)));
        meterId = opened.meterId;
        receipts.push(`approve meter #${meterId} ${opened.transactions.create}`);
        await until("the index to list the meter", async () => (await listMandates(deps, account.address)).meters.find((line) => line.id === opened.meterId));

        // `mm weir fetch`, three times: each a receipt for the next running total, and the API's answer.
        for (let call = 1n; call <= 3n; call += 1n) {
          const paid = await paidFetch(fetch, signer("weir:fetch", plan.offer.chainId), demo, { maxPrice: 10_000n });
          expect(paid).toMatchObject({ status: 200, price: plan.offer.price, total: plan.offer.price * call, meterId: opened.meterId });
          expect(JSON.parse(paid.body)).toMatchObject({ base: "USD", to: "EUR" });
        }
        const listed = (await listMandates(deps, account.address)).meters.find((line) => line.id === opened.meterId);
        expect(listed).toMatchObject({ requests: 3, used: (plan.offer.price * 3n).toString(), status: "Active" });

        // A request priced above the limit is refused before anything is signed.
        const jobs = host.jobs.length;
        await expect(paidFetch(fetch, signer("weir:fetch", plan.offer.chainId), demo, { maxPrice: plan.offer.price - 1n })).rejects.toMatchObject({ code: "PRICE_TOO_HIGH" });
        expect(host.jobs.length).toBe(jobs);

        // `mm weir unapprove`: one signature; after it, the API's offer can no longer be paid.
        const stop = await prepareMeterStop(deps, BigInt(opened.meterId), account.address);
        receipts.push(`unapprove meter #${meterId} ${await stopMeter(deps, stop, signer("weir:unapprove", stop.chainId))}`);
        meterId = undefined;
        await until("the index to see the stop", async () => ((await deps.api.meter(opened.meterId)).status === "Cancelled" ? true : undefined));
        await expect(paidFetch(fetch, signer("weir:fetch", plan.offer.chainId), demo, { maxPrice: 10_000n })).rejects.toMatchObject({ code: "NO_METER" });

        // Two to approve, three receipts, one stop.
        expect(host.jobs.map((job) => job.typedData && (job.typedData as { primaryType: string }).primaryType)).toEqual([
          "Permit",
          "MeterAuthorization",
          "UsageReceipt",
          "UsageReceipt",
          "UsageReceipt",
          "MeterCancel",
        ]);
      } finally {
        if (meterId !== undefined) {
          const id = meterId;
          await prepareMeterStop(deps, BigInt(id), account.address)
            .then((stop) => stopMeter(deps, stop, signer("weir:unapprove", stop.chainId)))
            .catch((error: unknown) => receipts.push(`could not stop meter #${id}: ${String(error)}`));
        }
        console.log(receipts.join("\n"));
      }
    },
    300_000,
  );
});
