/**
 * `mm weir faucet`: test dollars for the wallet on Monad Testnet, so an agent can try a
 * subscription end to end without anyone funding it first. Signs nothing.
 */

import { InputFieldType, schemaToFlags, type CommandIO, type InputSchema } from "@metamask/agent-wallet/plugin";

import { apiInput, WeirCommand, type Outcome } from "../../command.js";
import { requestTestDollars, type FaucetReport } from "../../core/faucet.js";
import { parseAddress } from "../../core/inputs.js";
import { renderFaucet } from "../../core/render.js";
import { walletAddress } from "../../host.js";

const inputs = {
  address: {
    type: InputFieldType.Text,
    flag: "address",
    message: "Send the test dollars here instead of to the wallet",
    required: false,
    prompt: false,
  },
  api: apiInput,
} satisfies InputSchema;

export default class WeirFaucet extends WeirCommand<FaucetReport> {
  static override summary = "Get test dollars on Monad Testnet";
  static override description = "Asks the Weir API's Testnet faucet for test dollars, sent to the wallet. Monad Testnet only; signs nothing.";
  static override examples = ["<%= config.bin %> weir faucet"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);

  protected readonly pluginCommandId = "weir:faucet";

  protected async perform(io: CommandIO): Promise<Outcome<FaucetReport>> {
    const input = await io.resolveInputs(inputs);
    const deps = this.deps(input.api);
    const address = input.address ? parseAddress(input.address, "--address") : walletAddress(this.host);
    io.progress("Asking the faucet...");
    const report = await requestTestDollars(deps, address);
    return { report, text: renderFaucet(report), hint: "Subscribe with `mm weir subscribe <link>`." };
  }
}
