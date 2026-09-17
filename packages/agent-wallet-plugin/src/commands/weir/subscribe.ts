/**
 * `mm weir subscribe <link or id>`: install a mandate for a plan, paid by this wallet, with no gas.
 *
 * The wallet signs two EIP-712 messages through the host's executor, a permit and the mandate, and
 * the Weir API's relayer submits both in one transaction. `--dry-run` stops before the first
 * signature and prints both payloads and the request that would carry them.
 */

import { InputFieldType, schemaToArgs, schemaToFlags, type CommandIO, type InputSchema } from "@metamask/agent-wallet/plugin";
import { zeroAddress, type Address } from "viem";

import { apiInput, WeirCommand, type Outcome } from "../../command.js";
import { WeirError } from "../../core/errors.js";
import { parseAddress } from "../../core/inputs.js";
import { renderSubscribe } from "../../core/render.js";
import { dryRunReport, install, installedReport, prepareInstall, requireFunds, signInstall, type SubscribeReport } from "../../core/subscribe.js";
import { walletAddress, walletSigner } from "../../host.js";

const inputs = {
  plan: {
    type: InputFieldType.Text,
    flag: "plan",
    message: "A Weir checkout link (…/c/pln_…) or a plan id (pln_…)",
    required: true,
    prompt: false,
    index: 0,
  },
  "dry-run": {
    type: InputFieldType.Boolean,
    flag: "dry-run",
    message: "Print what would be signed and sent, and stop before signing",
    default: false,
  },
  "from-savings": {
    type: InputFieldType.Boolean,
    flag: "from-savings",
    message: "Pay from the savings vault, so the money earns until each charge",
    default: false,
  },
  manager: {
    type: InputFieldType.Text,
    flag: "manager",
    message: "Another address that may pause, resume and stop the mandate but never spend, or `none`; the wallet itself by default",
    required: false,
    prompt: false,
  },
  payer: {
    type: InputFieldType.Text,
    flag: "payer",
    message: "With --dry-run only: preview for this address instead of the wallet's own",
    required: false,
    prompt: false,
  },
  api: apiInput,
} satisfies InputSchema;

export default class WeirSubscribe extends WeirCommand<SubscribeReport> {
  static override summary = "Subscribe this wallet to a Weir plan, with no gas";
  static override description =
    "Builds the mandate exactly as Weir's web checkout does, signs an EIP-2612 permit and the mandate with this wallet, and has the Weir API's relayer submit both. The wallet needs no MON. --dry-run prints both payloads without signing.";
  static override examples = [
    "<%= config.bin %> weir subscribe pln_5xjqdh77j4gflgvy --dry-run",
    "<%= config.bin %> weir subscribe https://weir.example/c/pln_5xjqdh77j4gflgvy",
    "<%= config.bin %> weir subscribe pln_5xjqdh77j4gflgvy --from-savings --json",
  ];
  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "weir:subscribe";

  protected async perform(io: CommandIO): Promise<Outcome<SubscribeReport>> {
    const input = await io.resolveInputs(inputs);
    const deps = this.deps(input.api);
    const dryRun = input["dry-run"];
    if (input.payer && !dryRun) {
      throw new WeirError("INVALID_INPUT", "--payer works only with --dry-run", "A real subscription is signed by the wallet, so the wallet is the payer.");
    }
    const payer = input.payer ? parseAddress(input.payer, "--payer") : walletAddress(this.host);
    const manager = managerFrom(input.manager);

    io.progress("Reading the plan and the chain...");
    const plan = await prepareInstall(deps, { planRef: input.plan, fromSavings: input["from-savings"], ...(manager === undefined ? {} : { manager }) }, payer);

    if (dryRun) {
      const report = dryRunReport(deps, plan);
      return {
        report,
        text: renderSubscribe(report),
        hint: plan.funds.enough
          ? `Run it without --dry-run to sign and subscribe.`
          : plan.chainId === 10143
            ? "The wallet cannot cover the first charge yet. Get test dollars with `mm weir faucet` first."
            : `The wallet cannot cover the first charge yet. Add ${plan.summary.asset.symbol} first.`,
      };
    }

    requireFunds(plan);
    io.progress();
    const request = await signInstall(plan, walletSigner(this.host, io, this.pluginCommandId, plan.chainId, payer));
    io.progress("Relaying the install...");
    const installed = await install(deps, plan, request);
    const report = installedReport(plan, installed);
    return { report, text: renderSubscribe(report), hint: "See it with `mm weir list`." };
  }
}

function managerFrom(value: string | undefined): Address | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.trim().toLowerCase() === "none") return zeroAddress;
  return parseAddress(value, "--manager");
}
