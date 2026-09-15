/**
 * Durable JSON-file primitives, used by the keeper's mandate cursor.
 *
 * Reached through the `@weir/shared/fs` subpath rather than the package barrel, on
 * purpose: it imports `node:fs`, and the web app imports the barrel into a browser
 * bundle. Keeping the node-only surface behind its own entry point means adding a
 * filesystem helper here can never turn into an externalized-builtin warning over there.
 *
 * There is exactly one implementation of the write-then-rename dance because there is
 * exactly one correct version of it.
 */

import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** True for the "no such file" error, which every loader here treats as "empty state". */
export function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

let tempCounter = 0;

/**
 * Replace a file's contents atomically: write a sibling temp file, flush it, then
 * `rename` over the target.
 *
 * A `rename` within one directory is atomic, so a crash at any point leaves either the
 * complete previous file or the complete new one, never a half-written record that a
 * restart has to guess about. Truncating in place has no such guarantee, and the failure
 * it produces is the worst one available: a file that parses far enough to look healthy
 * while missing the tail. For a cursor that is precisely fatal, because a torn cursor
 * still parses as a plausible block number and silently skips everything before
 * it.
 *
 * A whole-snapshot rewrite is chosen over an append-only log because callers *mutate*
 * records rather than only adding them: a log would need every change appended and
 * replayed, plus compaction, to answer "what is current". At these file sizes the rewrite
 * is a few kilobytes, and it is always exactly the current truth.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });

  tempCounter += 1;
  const temp = join(directory, `.${basename(filePath)}.${process.pid}.${tempCounter}.tmp`);

  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(contents, "utf8");
    // Flush before the rename, so the rename cannot publish an empty file.
    await handle.sync();
  } catch (cause) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
  await handle.close();

  try {
    await rename(temp, filePath);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }

  // Make the rename itself durable. Not every platform allows opening a directory;
  // where it fails the data is still complete, only the metadata flush is deferred.
  try {
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    /* best effort */
  }
}

/**
 * Serialize writes to one file so two concurrent commits cannot interleave snapshots.
 *
 * Each caller keeps its own queue instance. The rejection handler on the queue is
 * deliberate: a failed write must not poison every later write, while the promise handed
 * back to the caller still rejects so the caller can roll its in-memory state back.
 */
export class SerialFileWriter {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath: string) {}

  /** Queue a snapshot write. Resolves once this snapshot is on disk. */
  write(contents: string): Promise<void> {
    const attempt = (): Promise<void> => writeFileAtomic(this.filePath, contents);
    const write = this.#queue.then(attempt, attempt);
    this.#queue = write.catch(() => undefined);
    return write;
  }

  /** Resolve once every queued write has settled. */
  async settle(): Promise<void> {
    await this.#queue.catch(() => undefined);
  }
}
