/**
 * A small read-only HTTP server beside the loop, bound to 127.0.0.1 unless told otherwise.
 *
 * - `GET /health`: when the last pass ran, whether it finished, the working-set size and the
 *   last pass's outcome counts. 200 while the last pass finished, 503 before the first pass and
 *   after one that did not.
 * - `GET /due`: the ids due at the head right now, read fresh, as decimal strings, for a
 *   Chainlink CRE workflow that charges them through `MandateCharger.onReport`. It charges
 *   nothing itself. Concurrent requests share one read.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DueNow, KeeperHealth } from "./keeper.js";
import { describeError, type Logger } from "./log.js";

/** What the server needs from the keeper. */
export interface KeeperView {
  health(): KeeperHealth;
  dueNow(): Promise<DueNow>;
}

export interface KeeperServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startServer(options: {
  readonly host: string;
  readonly port: number;
  readonly keeper: KeeperView;
  readonly log: Logger;
}): Promise<KeeperServer> {
  const { keeper, log } = options;
  let dueRead: Promise<DueNow> | undefined;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://keeper").pathname;
    if (path !== "/health" && path !== "/due") return send(response, 404, { error: `no route ${path}` });
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      return send(response, 405, { error: `${request.method ?? "this method"} is not allowed` });
    }

    if (path === "/health") {
      const health = keeper.health();
      return send(response, health.lastPass?.ok === true ? 200 : 503, health);
    }

    try {
      dueRead ??= keeper.dueNow().finally(() => {
        dueRead = undefined;
      });
      const due = await dueRead;
      return send(response, 200, {
        chainId: keeper.health().chainId,
        blockNumber: due.blockNumber.toString(),
        timestamp: Number(due.timestamp),
        ids: due.ids.map(String),
      });
    } catch (error) {
      log.warn(`GET /due could not read the chain: ${describeError(error)}`);
      return send(response, 502, { error: "the chain could not be read" });
    }
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      log.error(`HTTP ${request.method} ${request.url} failed: ${describeError(error)}`);
      if (!response.headersSent) send(response, 500, { error: "internal error" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;

  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${json}\n`);
}
