/**
 * `mm weir stop <mandate id>`: stop a mandate for good, so nothing more can be charged. One
 * signature from the wallet, relayed with no gas.
 */

import { schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";

import { ActionCommand, actionInputs } from "../../action-command.js";

export default class WeirStop extends ActionCommand {
  static override summary = "Stop a Weir mandate, so nothing more can be charged";
  static override description =
    "Signs a MandateAction as the mandate's payer or manager and has the Weir API's relayer submit it. Works on periodic mandates and streams alike. --dry-run prints the payload without signing.";
  static override examples = ["<%= config.bin %> weir stop 12", "<%= config.bin %> weir stop 12 --dry-run --json"];
  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(actionInputs);
  static override args = schemaToArgs(actionInputs);

  protected readonly pluginCommandId = "weir:stop";
  protected readonly verb = "stop";
}
