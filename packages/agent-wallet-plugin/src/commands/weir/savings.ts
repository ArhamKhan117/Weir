/**
 * `mm weir savings [--in <dollars> | --out <dollars>]`: the wallet's balance and savings, and moves
 * between them with no gas. A move is one permit to Weir's savings router, which the relayer
 * submits; the money never leaves the wallet's own account.
 */

import { InputFieldType, schemaToFlags, type CommandIO, type InputSchema } from "@metamask/agent-wallet/plugin";

import { apiInput, WeirCommand, type Outcome } from "../../command.js";
import { WeirError } from "../../core/errors.js";
import { parseAmount } from "../../core/inputs.js";
import { renderSavings } from "../../core/render.js";
import { moveDryRun, prepareMove, readSavings, relayMove, savingsReport, signMove, type SavingsReport } from "../../core/savings.js";
import { walletAddress, walletSigner } from "../../host.js";

const inputs = {
  in: {
    type: InputFieldType.Text,
    flag: "in",
    message: "Dollars to move from the wallet's balance into savings",
    required: false,
    prompt: false,
  },
  out: {
    type: InputFieldType.Text,
    flag: "out",
    message: "Dollars to move from savings back to the wallet's balance",
    required: false,
    prompt: false,
  },
  asset: {
    type: InputFieldType.Text,
    flag: "asset",
    message: "Which asset's savings, by symbol or address, when there is more than one",
    required: false,
    prompt: false,
  },
  "dry-run": {
    type: InputFieldType.Boolean,
    flag: "dry-run",
    message: "With --in or --out: print what would be signed and sent, and stop before signing",
    default: false,
  },
  api: apiInput,
} satisfies InputSchema;

export default class WeirSavings extends WeirCommand<SavingsReport> {
  static override summary = "Show savings, and move money in or out with no gas";
  static override description =
    "Shows the wallet's balance and savings for each asset Weir offers savings in. --in moves dollars into savings and --out moves them back, each with one permit signature that the Weir API's relayer submits. Mandates set to pay from savings are charged straight from them.";
  static override examples = [
    "<%= config.bin %> weir savings",
    "<%= config.bin %> weir savings --in 25",
    "<%= config.bin %> weir savings --out 10.50 --dry-run",
  ];
  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);

  protected readonly pluginCommandId = "weir:savings";

  protected async perform(io: CommandIO): Promise<Outcome<SavingsReport>> {
    const input = await io.resolveInputs(inputs);
    if (input.in && input.out) {
      throw new WeirError("INVALID_INPUT", "Give --in or --out, not both", "Move one way at a time.");
    }
    const deps = this.deps(input.api);
    const owner = walletAddress(this.host);

    io.progress("Reading balances...");
    const state = await readSavings(deps, owner);
    const direction = input.in ? "deposit" : input.out ? "withdraw" : undefined;
    if (direction === undefined) {
      const report = savingsReport(state);
      return { report, text: renderSavings(report), hint: "Move money with --in <dollars> or --out <dollars>." };
    }

    const amount = parseAmount(direction === "deposit" ? input.in : input.out, direction === "deposit" ? "--in" : "--out");
    const plan = await prepareMove(deps, state, { direction, amount, ...(input.asset ? { asset: input.asset } : {}) });
    if (input["dry-run"]) {
      const report = moveDryRun(deps, state, plan);
      return { report, text: renderSavings(report), hint: "Run it without --dry-run to sign and move the money." };
    }

    io.progress();
    const request = await signMove(plan, walletSigner(this.host, io, this.pluginCommandId, plan.chainId, owner));
    io.progress("Relaying the move...");
    const report = await relayMove(deps, plan, request);
    return {
      report,
      text: renderSavings(report),
      hint:
        direction === "deposit"
          ? "Pay a plan from savings with `mm weir subscribe <link> --from-savings`."
          : "The money is back in the wallet's balance.",
    };
  }
}
