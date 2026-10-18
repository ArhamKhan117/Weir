/**
 * `mm weir approve <url>`: approve an API that charges with Weir pay-per-request, so this wallet
 * can pay its requests. Two signatures (a permit to the meter and the meter's terms), relayed with
 * no gas. `--dry-run` prints both payloads without signing.
 */

import { InputFieldType, schemaToArgs, schemaToFlags, type CommandIO, type InputSchema } from "@metamask/agent-wallet/plugin";
import type { Hex } from "viem";

import { apiInput, WeirCommand, type Outcome } from "../../command.js";
import { WeirError } from "../../core/errors.js";
import { parseAddress, parseAmount } from "../../core/inputs.js";
import { toJson, type Json } from "../../core/json.js";
import { openMeter, prepareApproval, signApproval } from "../../core/meter.js";
import { moneyExact, shortAddress } from "../../core/words.js";
import { walletAddress, walletSigner } from "../../host.js";

const inputs = {
  url: { type: InputFieldType.Text, flag: "url", message: "The API endpoint's URL", required: true, prompt: false, index: 0 },
  "per-day": { type: InputFieldType.Text, flag: "per-day", message: "At most this many dollars a day; the API's suggestion by default", required: false, prompt: false },
  total: { type: InputFieldType.Text, flag: "total", message: "At most this many dollars in all; the API's suggestion by default", required: false, prompt: false },
  days: { type: InputFieldType.Text, flag: "days", message: "How many days the approval lasts; the API's suggestion by default", required: false, prompt: false },
  manager: {
    type: InputFieldType.Text,
    flag: "manager",
    message: "Another key that may sign this wallet's receipts and stop the meter, but never raise it; the wallet itself by default",
    required: false,
    prompt: false,
  },
  "dry-run": { type: InputFieldType.Boolean, flag: "dry-run", message: "Print what would be signed and sent, and stop before signing", default: false },
  api: apiInput,
} satisfies InputSchema;

export interface ApproveReport {
  url: string;
  payTo: string;
  asset: string;
  price: string;
  perDay: string;
  total: string;
  expiresAt: number;
  meter: string;
  balance: string;
  signatures?: { what: "permit" | "authorization"; summary: string; typedData: Json }[];
  meterId?: string;
  transaction?: Hex;
  sentences: string[];
}

export default class WeirApprove extends WeirCommand<ApproveReport> {
  static override summary = "Approve an API that charges with Weir pay-per-request";
  static override description =
    "Reads the API's x402 offer (weir-meter), signs an EIP-2612 permit to Weir's meter and the meter's terms with this wallet, and has the Weir API's relayer open the meter. After that, `mm weir fetch` pays each request with one receipt signature. The wallet needs no MON.";
  static override examples = [
    "<%= config.bin %> weir approve https://api.example/v1/quote --dry-run",
    "<%= config.bin %> weir approve https://api.example/v1/quote --per-day 1 --total 5 --days 30",
  ];
  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "weir:approve";

  protected async perform(io: CommandIO): Promise<Outcome<ApproveReport>> {
    const input = await io.resolveInputs(inputs);
    const deps = this.deps(input.api);
    const days = input.days ? Number(input.days) : undefined;
    if (days !== undefined && !Number.isInteger(days)) throw new WeirError("INVALID_INPUT", "--days must be a whole number", "Write it like 30.");
    const payer = walletAddress(this.host);

    io.progress("Reading the API's offer and the chain...");
    const plan = await prepareApproval(
      deps,
      fetch,
      {
        url: input.url,
        ...(input["per-day"] ? { perDay: parseAmount(input["per-day"], "--per-day") } : {}),
        ...(input.total ? { total: parseAmount(input.total, "--total") } : {}),
        ...(days === undefined ? {} : { days }),
        ...(input.manager ? { manager: parseAddress(input.manager, "--manager") } : {}),
      },
      payer,
    );
    const base: ApproveReport = {
      url: plan.url,
      payTo: plan.offer.payTo,
      asset: plan.offer.asset,
      price: plan.offer.price.toString(),
      perDay: plan.terms.periodCap.toString(),
      total: plan.terms.maxTotal.toString(),
      expiresAt: Number(plan.terms.expiresAt),
      meter: plan.offer.meter,
      balance: plan.balance.toString(),
      sentences: [
        `${new URL(plan.url).host} charges ${moneyExact(plan.offer.price)} a request, paid to ${shortAddress(plan.offer.payTo)}.`,
        `This approves at most ${moneyExact(plan.terms.periodCap)} a day and ${moneyExact(plan.terms.maxTotal)} in all, until ${new Date(Number(plan.terms.expiresAt) * 1000).toISOString().slice(0, 10)}.`,
      ],
    };

    if (input["dry-run"]) {
      const report: ApproveReport = {
        ...base,
        signatures: [
          { what: "permit", summary: plan.permit.request.summary, typedData: toJson(plan.permit.request.typedData) },
          { what: "authorization", summary: plan.authorization.request.summary, typedData: toJson(plan.authorization.request.typedData) },
        ],
      };
      return { report, text: report.sentences.join("\n"), hint: "Run it without --dry-run to sign and approve." };
    }

    io.progress();
    const request = await signApproval(plan, walletSigner(this.host, io, this.pluginCommandId, plan.offer.chainId, payer));
    io.progress("Relaying the approval...");
    const opened = await openMeter(fetch, plan, request);
    const report: ApproveReport = {
      ...base,
      meterId: opened.meterId,
      transaction: opened.transactions.create,
      sentences: [...base.sentences, `Approved: meter ${opened.meterId}, opened in ${opened.transactions.create}.`],
    };
    return { report, text: report.sentences.join("\n"), hint: `Pay a request with \`mm weir fetch ${plan.url}\`.` };
  }
}
