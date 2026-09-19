/**
 * One-line process logging.
 *
 * Every line is `api: <message> key=value ...`, so a log reads as prose and still greps by field.
 * Nothing here knows what a secret is, which is why no caller ever hands it one: configuration
 * holds keys as `Secret`, whose string form is a redaction marker, and request logging records
 * the method, path, status and duration only.
 */

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

function render(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return /^[\w.:/@-]*$/.test(value) && value !== "" ? value : JSON.stringify(value);
  if (value === undefined) return "undefined";
  return JSON.stringify(value) ?? String(value);
}

export function formatLine(scope: string, message: string, fields?: LogFields): string {
  const parts = fields === undefined ? [] : Object.entries(fields).map(([key, value]) => `${key}=${render(value)}`);
  return [`${scope}: ${message}`, ...parts].join(" ");
}

/** A logger writing to the console, one line per call. */
export function createLogger(scope = "api"): Logger {
  return {
    info: (message, fields) => console.log(formatLine(scope, message, fields)),
    warn: (message, fields) => console.warn(formatLine(scope, message, fields)),
    error: (message, fields) => console.error(formatLine(scope, message, fields)),
  };
}

/** For tests and for callers that want nothing printed. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** The message of anything thrown, never its stack or its properties. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // viem errors carry a multi-line message with request details; the first line is the summary.
    const short = (error as { shortMessage?: unknown }).shortMessage;
    return typeof short === "string" && short !== "" ? short : (error.message.split("\n")[0] ?? error.message);
  }
  return String(error);
}
