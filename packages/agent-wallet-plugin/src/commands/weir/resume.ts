/**
 * `mm weir resume <mandate id>`: resume a paused per-second stream.
 */

import { schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";

import { ActionCommand, actionInputs } from "../../action-command.js";

export default class WeirResume extends ActionCommand {
  static override summary = "Resume a paused per-second Weir stream";
  static override description =
    "Starts billing a paused stream by the second again. Pause and resume apply to per-second streams only. Signs a MandateAction and has the Weir API's relayer submit it.";
  static override examples = ["<%= config.bin %> weir resume 12", "<%= config.bin %> weir resume 12 --dry-run --json"];
  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(actionInputs);
  static override args = schemaToArgs(actionInputs);

  protected readonly pluginCommandId = "weir:resume";
  protected readonly verb = "resume";
}
