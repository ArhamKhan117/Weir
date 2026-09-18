/**
 * What every `mm weir` command shares: the `--api` input, the choice between words and JSON, and
 * the one place a failure becomes the host's own error.
 *
 * The host picks the output format: plain text in a terminal, JSON when stdout is not a terminal
 * or `--json` is given, TOON with `--toon`. A command here returns its report as an object for the
 * structured formats and as finished sentences for text, which the host prints as they are, with
 * the command's next-step hint underneath.
 *
 * This file lives outside `src/commands/` because oclif treats every module there as a command.
 */

import { CommandError, InputFieldType, PluginCommand, type CommandIO, type TextField } from "@metamask/agent-wallet/plugin";

import { createDeps, type Deps } from "./core/deps.js";
import { isWeirError, messageOf } from "./core/errors.js";
import { resolveSettings } from "./core/settings.js";
import type { HostContextLike } from "./host.js";

export const apiInput = {
  type: InputFieldType.Text,
  flag: "api",
  message: "The Weir API to use; WEIR_API_URL, or http://localhost:8790 when neither is set",
  required: false,
  prompt: false,
} satisfies TextField;

/** A report for machines, the same report in words for people, and what to do next. */
export interface Outcome<R> {
  report: R;
  text: string;
  hint?: string;
}

export abstract class WeirCommand<R extends object> extends PluginCommand<R | string> {
  #hint: string | undefined;

  protected abstract perform(io: CommandIO): Promise<Outcome<R>>;

  async execute(io: CommandIO): Promise<R | string> {
    try {
      const outcome = await this.perform(io);
      this.#hint = outcome.hint;
      return this.outputFormat === "text" ? outcome.text : outcome.report;
    } catch (error) {
      throw toCommandError(error);
    } finally {
      io.progress();
    }
  }

  override successHint(): string | undefined {
    return this.#hint;
  }

  /** The restricted context, as the members this plugin uses. */
  protected get host(): HostContextLike {
    return this.ctx as unknown as HostContextLike;
  }

  protected deps(api: string | undefined): Deps {
    return createDeps(resolveSettings({ api }, process.env));
  }
}

/** A failure as the host renders it: a code, a sentence and a hint. Host errors pass through. */
export function toCommandError(error: unknown): Error {
  if (error instanceof CommandError) return error;
  if (isWeirError(error)) return new CommandError(error.code, error.message, error.hint);
  if (error instanceof Error && typeof (error as { code?: unknown }).code === "string" && typeof (error as { hint?: unknown }).hint === "string") {
    return error;
  }
  return new CommandError("UNEXPECTED", messageOf(error), "This looks like a fault in the Weir plugin. Run again with --verbose and report what it prints.");
}
