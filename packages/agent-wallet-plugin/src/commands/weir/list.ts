/**
 * `mm weir list`: the wallet's mandates with their standing, next charge and totals, from the Weir
 * API's index. Reads the wallet's address with `wallet-read`; `--payer` lists any address instead.
 * Signs nothing, so it needs no login.
 */

import { InputFieldType, type CommandIO, type InputSchema, schemaToFlags } from "@metamask/agent-wallet/plugin";

import { apiInput, WeirCommand, type Outcome } from "../../command.js";
import { parseAddress } from "../../core/inputs.js";
import { listMandates, type ListReport } from "../../core/list.js";
import { renderList } from "../../core/render.js";
import { walletAddress } from "../../host.js";

const inputs = {
  payer: {
    type: InputFieldType.Text,
    flag: "payer",
    message: "List the mandates of this address instead of the wallet's own",
    required: false,
    prompt: false,
  },
  api: apiInput,
} satisfies InputSchema;

export default class WeirList extends WeirCommand<ListReport> {
  static override summary = "List this wallet's Weir mandates";
  static override description =
    "Every mandate the wallet pays: its standing, price, next charge, what it has taken against its cap and when it ends, with totals. From the Weir API's index.";
  static override examples = ["<%= config.bin %> weir list", "<%= config.bin %> weir list --payer 0x4e80fA4AD069245b976ad4FD4Ff1d8f94965aF8C --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);

  protected readonly pluginCommandId = "weir:list";

  protected async perform(io: CommandIO): Promise<Outcome<ListReport>> {
    const input = await io.resolveInputs(inputs);
    const deps = this.deps(input.api);
    const payer = input.payer ? parseAddress(input.payer, "--payer") : walletAddress(this.host);
    io.progress("Reading mandates...");
    const report = await listMandates(deps, payer);
    const live = report.mandates.find((line) => line.standing === "Active" || line.standing === "Past due" || line.standing === "Paused");
    return {
      report,
      text: renderList(report),
      ...(live === undefined
        ? { hint: "Find a plan with `mm weir plan <link>` and subscribe with `mm weir subscribe <link>`." }
        : { hint: `Stop one with \`mm weir stop <id>\`; pause or resume a per-second stream with \`mm weir pause <id>\`.` }),
    };
  }
}
