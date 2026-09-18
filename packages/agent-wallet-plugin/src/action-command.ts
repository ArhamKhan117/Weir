/**
 * The shape `mm weir stop`, `pause` and `resume` share: one mandate id, one signature from the
 * wallet as the mandate's payer (or its manager), relayed with no gas.
 */

import { InputFieldType, type CommandIO, type InputSchema } from "@metamask/agent-wallet/plugin";

import { apiInput, WeirCommand, type Outcome } from "./command.js";
import { actionDryRun, prepareAction, relayAction, signAction, type ActionReport, type Verb } from "./core/actions.js";
import { parseMandateId } from "./core/inputs.js";
import { renderAction } from "./core/render.js";
import { walletAddress, walletSigner } from "./host.js";

export const actionInputs = {
  mandate: {
    type: InputFieldType.Text,
    flag: "mandate",
    message: "The mandate's id, from `mm weir list`",
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
  api: apiInput,
} satisfies InputSchema;

const PROGRESS: Record<Verb, string> = { stop: "Relaying the stop...", pause: "Relaying the pause...", resume: "Relaying the resume..." };

export abstract class ActionCommand extends WeirCommand<ActionReport> {
  protected abstract readonly verb: Verb;

  protected async perform(io: CommandIO): Promise<Outcome<ActionReport>> {
    const input = await io.resolveInputs(actionInputs);
    const deps = this.deps(input.api);
    const mandateId = parseMandateId(input.mandate);
    const signer = walletAddress(this.host);

    io.progress("Reading the mandate...");
    const plan = await prepareAction(deps, { mandateId, verb: this.verb }, signer);
    if (input["dry-run"]) {
      const report = actionDryRun(deps, plan);
      return { report, text: renderAction(report), hint: `Run it without --dry-run to sign and ${this.verb} it.` };
    }

    io.progress();
    const request = await signAction(plan, walletSigner(this.host, io, this.pluginCommandId, plan.chainId, signer));
    io.progress(PROGRESS[this.verb]);
    const report = await relayAction(deps, plan, request);
    return { report, text: renderAction(report), hint: "See where things stand with `mm weir list`." };
  }
}
