/**
 * `mm weir fetch <url>`: make a request to an API that charges with Weir pay-per-request, paying
 * it from this wallet's meter for that API. One signature (a usage receipt), no transaction.
 */

import { InputFieldType, schemaToArgs, schemaToFlags, type CommandIO, type InputSchema } from "@metamask/agent-wallet/plugin";

import { apiInput, WeirCommand, type Outcome } from "../../command.js";
import { parseAmount } from "../../core/inputs.js";
import { paidFetch } from "../../core/meter.js";
import { moneyExact } from "../../core/words.js";
import { walletAddress, walletSigner } from "../../host.js";

const inputs = {
  url: { type: InputFieldType.Text, flag: "url", message: "The URL to request", required: true, prompt: false, index: 0 },
  "max-price": {
    type: InputFieldType.Text,
    flag: "max-price",
    message: "Refuse a request priced above this many dollars; 0.01 by default",
    required: false,
    prompt: false,
  },
  method: { type: InputFieldType.Text, flag: "method", message: "The HTTP method; GET by default", required: false, prompt: false },
  data: { type: InputFieldType.Text, flag: "data", message: "A request body, sent as JSON", required: false, prompt: false },
  api: apiInput,
} satisfies InputSchema;

export interface FetchReport {
  url: string;
  status: number;
  contentType: string;
  body: string;
  price?: string;
  total?: string;
  meterId?: string;
}

export default class WeirFetch extends WeirCommand<FetchReport> {
  static override summary = "Request a URL, paying it with Weir pay-per-request";
  static override description =
    "Requests the URL; when it answers 402 with a weir-meter offer at or under --max-price, signs one usage receipt with this wallet for the wallet's meter with that API and requests it again. No transaction and no MON. Approve the API first with `mm weir approve`.";
  static override examples = [
    "<%= config.bin %> weir fetch https://api.example/v1/quote?to=PKR",
    "<%= config.bin %> weir fetch https://api.example/v1/summarize --method POST --data '{\"url\":\"https://example.com\"}' --json",
  ];
  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "weir:fetch";

  protected async perform(io: CommandIO): Promise<Outcome<FetchReport>> {
    const input = await io.resolveInputs(inputs);
    const deps = this.deps(input.api);
    const payer = walletAddress(this.host);
    const maxPrice = input["max-price"] ? parseAmount(input["max-price"], "--max-price") : 10_000n;
    const chainId = deps.settings.expectedChainId ?? 10143;
    io.progress("Requesting...");
    const result = await paidFetch(fetch, walletSigner(this.host, io, this.pluginCommandId, chainId, payer), input.url, {
      maxPrice,
      ...(input.method ? { method: input.method.toUpperCase() } : {}),
      ...(input.data ? { body: input.data } : {}),
    });
    const report: FetchReport = {
      url: result.url,
      status: result.status,
      contentType: result.contentType,
      body: result.body,
      ...(result.price === undefined ? {} : { price: result.price.toString() }),
      ...(result.total === undefined ? {} : { total: result.total.toString() }),
      ...(result.meterId === undefined ? {} : { meterId: result.meterId }),
    };
    const paidLine = result.price === undefined ? "Not paid: the API did not ask." : `Paid ${moneyExact(result.price)}; running total ${moneyExact(result.total ?? 0n)} on meter ${result.meterId}.`;
    return { report, text: `${paidLine}\nHTTP ${result.status}\n${result.body}`, hint: "Settled on chain in batches; `mm weir list` shows the meter." };
  }
}
