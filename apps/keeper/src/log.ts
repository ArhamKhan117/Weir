/**
 * One line per event, timestamped, to stdout (info) and stderr (warn, error).
 *
 * Every module takes a {@link Logger} rather than calling `console` itself, so tests run silent
 * and can assert on what a pass said.
 */

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createConsoleLogger(now: () => Date = () => new Date()): Logger {
  const line = (level: string, message: string) => `${now().toISOString()} ${level.padEnd(5)} ${message}`;
  return {
    info: (message) => console.log(line("info", message)),
    warn: (message) => console.warn(line("warn", message)),
    error: (message) => console.error(line("error", message)),
  };
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A logger that keeps every line, for tests. */
export function createMemoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
}

/**
 * An error and its causes on one line. For a viem error, the first line of its short message and
 * the node's own words (`details`, such as "Signer had insufficient balance"), which is where the
 * useful part of an RPC failure lives.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 6; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    const viem = current as Error & { shortMessage?: string; details?: string };
    const line = clean(viem.shortMessage ?? viem.message);
    if (line !== "" && !parts.includes(line)) parts.push(line);
    if (typeof viem.details === "string" && clean(viem.details) !== "") {
      const details = clean(viem.details);
      if (!parts.includes(details)) parts.push(details);
      break;
    }
    current = current.cause;
  }
  return parts.join(": ") || "unknown error";
}

/** The first line, without a trailing period, so parts join cleanly. */
function clean(text: string): string {
  return (text.split("\n")[0] ?? "").trim().replace(/\.$/, "");
}
