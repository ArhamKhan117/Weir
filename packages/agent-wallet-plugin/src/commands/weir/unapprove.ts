/**
 * `mm weir unapprove <meter id>`: stop paying an API that charges with Weir pay-per-request. One
 * signature from the wallet, as the meter's payer or manager, relayed with no gas. Requests already
 * paid are still settled; nothing new can be.
 */

import { InputFieldType, schemaToArgs, schemaToFlags, type CommandIO, type InputSchema } from "@metamask/agent-wallet/plugin";
import { explorerUrl } from "@weir/shared";
import type { Hex } from "viem";

import { apiInput, WeirCommand, type Outcome } from "../../command.js";
import { WeirError } from "../../core/errors.js";
import { toJson, type Json } from "../../core/json.js";
import { meterStopRequest, prepareMeterStop, stopMeter } from "../../core/meter.js";
import { walletAddress, walletSigner } from "../../host.js";

const inputs = {
  meter: { type: InputFieldType.Text, flag: "meter", message: "The meter's id, from `mm weir list`", required: true, prompt: false, index: 0 },
  "dry-run": { type: InputFieldType.Boolean, flag: "dry-run", message: "Print what would be signed and sent, and stop before signing", default: false },
  api: apiInput,
} satisfies InputSchema;

export interface UnapproveReport {
  meterId: string;
  title: string;
  signer: string;
  role: "payer" | "manager";
  chainId: number;
  dryRun: boolean;
  signature?: { summary: string; typedData: Json };
  request?: Json;
  transaction?: Hex;
  explorerUrl?: string;
  sentences: string[];
}

export default class WeirUnapprove extends WeirCommand<UnapproveReport> {
  static override summary = "Stop paying an API that charges with Weir pay-per-request";
  static override description =
    "Signs a MeterCancel as the meter's payer or manager and has the Weir API's relayer submit it. Requests already paid are still settled; nothing new is paid. --dry-run prints the payload without signing.";
  static override examples = ["<%= config.bin %> weir unapprove 7", "<%= config.bin %> weir unapprove 7 --dry-run --json"];
  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "weir:unapprove";

  protected async perform(io: CommandIO): Promise<Outcome<UnapproveReport>> {
    const input = await io.resolveInputs(inputs);
    const deps = this.deps(input.api);
    const text = input.meter.trim().replace(/^#/, "");
    if (!/^[1-9]\d{0,76}$/.test(text)) throw new WeirError("INVALID_INPUT", `"${input.meter}" is not a meter id`, "A meter id is a whole number such as 7. See `mm weir list`.");
    const signer = walletAddress(this.host);

    io.progress("Reading the meter...");
    const plan = await prepareMeterStop(deps, BigInt(text), signer);
    const base = { meterId: plan.meter.id, title: plan.title, signer: plan.signer, role: plan.role, chainId: plan.chainId };
    if (input["dry-run"]) {
      const report: UnapproveReport = {
        ...base,
        dryRun: true,
        signature: { summary: plan.request.summary, typedData: toJson(plan.request.typedData) },
        request: toJson({ ...meterStopRequest(plan, "0x"), signature: "<the wallet's signature>" }),
        sentences: [`This would stop meter #${plan.meter.id} for ${plan.title}, signed as its ${plan.role}.`],
      };
      return { report, text: report.sentences.join("\n"), hint: "Run it without --dry-run to sign and stop it." };
    }

    io.progress();
    const transaction = await stopMeter(deps, plan, walletSigner(this.host, io, this.pluginCommandId, plan.chainId, signer));
    const report: UnapproveReport = {
      ...base,
      dryRun: false,
      transaction,
      explorerUrl: explorerUrl(plan.chainId, "tx", transaction),
      sentences: [`Stopped meter #${plan.meter.id} for ${plan.title} in ${transaction}. Requests already paid are still settled.`],
    };
    return { report, text: report.sentences.join("\n"), hint: "See where things stand with `mm weir list`." };
  }
}
