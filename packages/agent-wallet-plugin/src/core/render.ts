/**
 * Reports as the plain text a person reads in a terminal. Agents ask for `--json` and get the
 * report itself; everything here is for eyes, and nothing an agent needs lives only here.
 */

import { networkFor } from "@weir/shared";

import type { ActionReport } from "./actions.js";
import type { FaucetReport } from "./faucet.js";
import type { Json } from "./json.js";
import type { ListReport } from "./list.js";
import type { PlanSummary } from "./plan.js";
import type { SavingsReport } from "./savings.js";
import type { SubscribeReport } from "./subscribe.js";
import { apyPhrase, money } from "./words.js";

const DRY_RUN = "Dry run: nothing was signed or sent.";

/** Label and value rows, the labels padded to one column. */
function rows(entries: [string, string][], indent = "  "): string {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, value]) => `${indent}${label.padEnd(width)}  ${value}`).join("\n");
}

export function renderPlan(plan: PlanSummary): string {
  const lines = [`${plan.name} from ${plan.merchant.name}`];
  if (plan.description !== "") lines.push(plan.description);
  lines.push("");
  const entries: [string, string][] = [
    ["Price", plan.words.price],
    ["First charge", plan.words.firstCharge],
    ["Limits", plan.words.limits],
    ["Term", plan.words.term],
    ["Pays with", plan.words.asset],
    ["Merchant", plan.words.merchant],
  ];
  if (plan.words.savings !== undefined) entries.push(["Savings", plan.words.savings]);
  lines.push(rows(entries));
  if (!plan.active) lines.push("", `Not taking new subscribers: ${plan.merchant.name} has paused this plan.`);
  return lines.join("\n");
}

/** A typed-data payload as its domain line and its message, one field a line. */
function renderTypedData(typedData: Json, indent: string): string {
  const data = typedData as { domain?: Record<string, Json>; primaryType?: string; message?: Json };
  const domain = data.domain ?? {};
  const named = typeof domain["name"] === "string" ? `"${domain["name"]}"` : "no name";
  const version = typeof domain["version"] === "string" ? ` version ${domain["version"]}` : "";
  const lines = [
    `${indent}EIP-712 ${data.primaryType ?? "message"} under ${named}${version}, chain ${String(domain["chainId"])}, contract ${String(domain["verifyingContract"])}`,
  ];
  lines.push(...fields(data.message ?? null, `${indent}  `));
  return lines.join("\n");
}

function fields(value: Json, indent: string): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${indent}${String(value)}`];
  const entries = Object.entries(value);
  const width = Math.max(...entries.map(([key]) => key.length));
  return entries.flatMap(([key, inner]) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner) ? [`${indent}${key}`, ...fields(inner, `${indent}  `)] : [`${indent}${key.padEnd(width)}  ${String(inner)}`],
  );
}


export function renderSubscribe(report: SubscribeReport): string {
  const { plan } = report;
  const funds =
    report.funds.firstCharge === "0"
      ? `${report.paysFrom}, ${money(report.funds.available)} of ${plan.asset.symbol} now; nothing is charged at install`
      : `${report.paysFrom}, ${money(report.funds.available)} of ${plan.asset.symbol} now; the first charge is ${money(report.funds.firstCharge)}${report.funds.enough ? "" : ", which it does not cover yet"}`;
  const manager =
    report.manager === "0x0000000000000000000000000000000000000000"
      ? "none: only the payer can pause, resume or stop it"
      : `${report.manager}${report.manager.toLowerCase() === report.payer.toLowerCase() ? " (the payer)" : ""}, which can pause, resume and stop it but never spend`;

  if (!report.dryRun) {
    const first =
      plan.mode === "streaming"
        ? "It is running now, billed by the second."
        : plan.firstCharge === "0"
          ? `${plan.words.firstCharge}.`
          : `The first charge of ${money(plan.firstCharge)} happens in a moment.`;
    return [
      `Subscribed to ${plan.name} from ${plan.merchant.name}: ${plan.words.price}.`,
      rows([
        ["Mandate", `#${report.mandateId ?? "?"}`],
        ["Transaction", report.transaction ?? "?"],
        ["Receipt", report.explorerUrl ?? "?"],
      ]),
      `${first} At most ${money(plan.maxTotal)} in total, until ${plan.words.ends}. Stop it any time with \`mm weir stop ${report.mandateId ?? "<id>"}\`.`,
    ].join("\n");
  }

  const lines = [
    DRY_RUN,
    "",
    `${plan.name} from ${plan.merchant.name}: ${plan.words.price}`,
    rows([
      ["Payer", report.payer],
      ["Manager", manager],
      ["Pays from", funds],
      ["Limits", plan.words.limits],
      ["Term", plan.words.term],
    ]),
    "",
    "The wallet would sign, in order:",
  ];
  (report.signatures ?? []).forEach((signature, index) => {
    lines.push("", `${index + 1}. ${signature.summary}`, renderTypedData(signature.typedData, "   "));
  });
  if (report.request !== undefined) {
    const all = (report.signatures ?? []).length === 2 ? "both go" : "all three go";
    lines.push("", `Then ${all} to ${report.request.method} ${report.request.url}, and the relayer pays the gas.`);
  }
  return lines.join("\n");
}

const STANDING_WIDTH = 9;

export function renderList(report: ListReport): string {
  const where = report.network === undefined ? "" : ` on ${report.network.label}`;
  if (report.mandates.length === 0) return `No mandates paid by ${report.payer}${where} yet.`;
  const lines = [`Mandates paid by ${report.payer}${where}`];
  for (const line of report.mandates) {
    lines.push(
      "",
      `#${line.id.padEnd(4)} ${`[${line.standing}]`.padEnd(STANDING_WIDTH + 2)} ${line.title}`,
      `      ${line.words.price}, from ${line.paysFrom}. ${line.words.next}.`,
      `      ${line.words.paid}. ${line.words.ends}.`,
    );
  }
  const paid = Object.entries(report.totals.paid)
    .map(([symbol, units]) => `${money(units)} in ${symbol}`)
    .join(", ");
  lines.push(
    "",
    `${report.totals.mandates} mandate${report.totals.mandates === 1 ? "" : "s"}: ${report.totals.running} running, ${report.totals.paused} paused. Paid so far: ${paid === "" ? "nothing" : paid}.`,
  );
  if (report.totals.next !== undefined) lines.push(`Next: ${report.totals.next.words}.`);
  return lines.join("\n");
}

const DONE: Record<ActionReport["verb"], string> = {
  stop: "Stopped",
  pause: "Paused",
  resume: "Resumed",
};

const AFTER: Record<ActionReport["verb"], (id: string) => string> = {
  stop: () => "Nothing more can be charged on it.",
  pause: (id) => `Nothing is billed until it is resumed with \`mm weir resume ${id}\`.`,
  resume: () => "It is billing by the second again.",
};

export function renderAction(report: ActionReport): string {
  if (report.dryRun) {
    const lines = [
      DRY_RUN,
      "",
      `Would ${report.verb} ${report.title} (mandate #${report.mandateId}), signing as its ${report.role}:`,
    ];
    if (report.signature !== undefined) lines.push("", `1. ${report.signature.summary}`, renderTypedData(report.signature.typedData, "   "));
    if (report.request !== undefined) lines.push("", `Then it goes to ${report.request.method} ${report.request.url}, and the relayer pays the gas.`);
    return lines.join("\n");
  }
  return [
    `${DONE[report.verb]} ${report.title} (mandate #${report.mandateId}). ${AFTER[report.verb](report.mandateId)}`,
    rows([
      ["Transaction", report.transaction ?? "?"],
      ["Receipt", report.explorerUrl ?? "?"],
    ]),
  ].join("\n");
}

export function renderSavings(report: SavingsReport): string {
  const lines: string[] = [];
  const move = report.move;
  if (move !== undefined) {
    const into = move.direction === "deposit";
    if (move.dryRun) {
      lines.push(DRY_RUN, "", `Would move ${money(move.amount)} of ${move.assetSymbol} ${into ? "into" : "out of"} savings.`);
      if (move.signature !== undefined) lines.push("", `1. ${move.signature.summary}`, renderTypedData(move.signature.typedData, "   "));
      if (move.request !== undefined) lines.push("", `Then it goes to ${move.request.method} ${move.request.url}, and the relayer pays the gas.`);
      lines.push("", "Now:");
    } else {
      lines.push(
        `Moved ${money(move.amount)} of ${move.assetSymbol} ${into ? "into" : "out of"} savings.`,
        rows([
          ["Transaction", move.transaction ?? "?"],
          ["Receipt", move.explorerUrl ?? "?"],
        ]),
        "",
      );
    }
  }
  const network = networkFor(report.chainId).label;
  if (report.accounts.length === 0) {
    lines.push(`Weir offers no savings on ${network}.`);
    return lines.join("\n");
  }
  if (move === undefined || !move.dryRun) lines.push(`Savings for ${report.owner} on ${network}`);
  for (const account of report.accounts) {
    lines.push(
      "",
      `${account.assetSymbol}: ${account.name} (${account.symbol})${account.apyBps === undefined ? "" : `, earning ${apyPhrase(account.apyBps)}`}`,
      rows([
        ["Balance", money(account.balance)],
        ["Savings", money(account.saved)],
      ]),
    );
  }
  return lines.join("\n");
}

export function renderFaucet(report: FaucetReport): string {
  return [
    `Sent ${money(report.amount)} in test dollars to ${report.address} on ${networkFor(report.chainId).label}.`,
    rows([
      ["Token", report.asset],
      ["Transaction", report.transaction],
      ["Receipt", report.explorerUrl],
    ]),
  ].join("\n");
}
