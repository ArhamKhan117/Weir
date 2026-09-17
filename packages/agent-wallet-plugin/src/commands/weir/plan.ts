/**
 * `mm weir plan <link or id>`: a plan's terms in plain words. Reads the public checkout answer and
 * needs no wallet, no login and no capability.
 */

import { InputFieldType, schemaToArgs, schemaToFlags, type CommandIO, type InputSchema } from "@metamask/agent-wallet/plugin";

import { apiInput, WeirCommand, type Outcome } from "../../command.js";
import { parsePlanRef } from "../../core/inputs.js";
import { summarizePlan, type PlanSummary } from "../../core/plan.js";
import { renderPlan } from "../../core/render.js";
import { chainOf } from "../../core/settings.js";

const inputs = {
  plan: {
    type: InputFieldType.Text,
    flag: "plan",
    message: "A Weir checkout link (…/c/pln_…) or a plan id (pln_…)",
    required: true,
    prompt: false,
    index: 0,
  },
  api: apiInput,
} satisfies InputSchema;

export default class WeirPlan extends WeirCommand<PlanSummary> {
  static override summary = "Show a Weir plan's terms in plain words";
  static override description =
    "Price, cadence, caps, term, asset and merchant for a Weir checkout link or plan id, from the Weir API's public checkout answer. Needs no wallet.";
  static override examples = ["<%= config.bin %> weir plan pln_5xjqdh77j4gflgvy", "<%= config.bin %> weir plan https://weir.example/c/pln_5xjqdh77j4gflgvy --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "weir:plan";

  protected async perform(io: CommandIO): Promise<Outcome<PlanSummary>> {
    const input = await io.resolveInputs(inputs);
    const deps = this.deps(input.api);
    const planId = parsePlanRef(input.plan);
    io.progress("Reading the plan...");
    const checkout = await deps.api.checkout(planId);
    const summary = summarizePlan(checkout, chainOf(checkout.chainId, deps.settings), deps.now());
    return {
      report: summary,
      text: renderPlan(summary),
      hint: summary.active
        ? `Subscribe with \`mm weir subscribe ${summary.id}\`, or preview the signatures first with --dry-run.`
        : "This plan is paused; nothing can be subscribed to until the business reopens it.",
    };
  }
}
