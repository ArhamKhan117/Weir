/**
 * `mm weir pause <mandate id>`: pause a per-second stream. Periodic mandates cannot be paused,
 * only stopped, and the command says so before anything is signed.
 */

import { schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";

import { ActionCommand, actionInputs } from "../../action-command.js";

export default class WeirPause extends ActionCommand {
  static override summary = "Pause a per-second Weir stream";
  static override description =
    "Settles what the stream has accrued and stops billing until it is resumed. Pause and resume apply to per-second streams only; a periodic mandate can only be stopped. Signs a MandateAction and has the Weir API's relayer submit it.";
  static override examples = ["<%= config.bin %> weir pause 12", "<%= config.bin %> weir pause 12 --dry-run --json"];
  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(actionInputs);
  static override args = schemaToArgs(actionInputs);

  protected readonly pluginCommandId = "weir:pause";
  protected readonly verb = "pause";
}
