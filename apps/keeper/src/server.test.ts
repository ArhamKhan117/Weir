import { afterEach, describe, expect, it } from "vitest";
import type { DueNow, KeeperHealth } from "./keeper.js";
import { silentLogger } from "./log.js";
import { startServer, type KeeperServer } from "./server.js";

const healthBefore: KeeperHealth = {
  chainId: 10143,
  keeper: "0x2222222222222222222222222222222222222222",
  startedAt: "2026-09-25T12:00:00.000Z",
  lastPass: null,
  lastSuccessfulPassAt: null,
  workingSet: 0,
  waitingForRetry: 0,
  lastOutcomes: null,
};

const healthAfter: KeeperHealth = {
  ...healthBefore,
  lastPass: { at: "2026-09-25T12:00:05.000Z", ok: true, durationMs: 812, head: "65559700", errors: [] },
  lastSuccessfulPassAt: "2026-09-25T12:00:05.000Z",
  workingSet: 7,
  lastOutcomes: { workingSet: 7, due: 3, charged: 2, pastDue: 1, reverted: 0, dropped: 1, deferred: 0 },
};

let server: KeeperServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("the keeper's HTTP server", () => {
  it("reports health, 503 until a pass has finished and 200 after", async () => {
    let health = healthBefore;
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      keeper: { health: () => health, dueNow: () => Promise.reject(new Error("unused")) },
      log: silentLogger,
    });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const before = await fetch(`${server.url}/health`);
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual(healthBefore);

    health = healthAfter;
    const after = await fetch(`${server.url}/health`);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual(healthAfter);
  });

  it("serves the ids due now as strings, sharing one read between concurrent requests", async () => {
    let reads = 0;
    const due: DueNow = { blockNumber: 65_559_700n, timestamp: 1_790_000_000n, ids: [1n, 12n, 2n ** 70n] };
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      keeper: {
        health: () => healthAfter,
        dueNow: async () => {
          reads += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return due;
        },
      },
      log: silentLogger,
    });
    const [first, second] = await Promise.all([fetch(`${server.url}/due`), fetch(`${server.url}/due`)]);
    expect(first.status).toBe(200);
    const body = { chainId: 10143, blockNumber: "65559700", timestamp: 1_790_000_000, ids: ["1", "12", "1180591620717411303424"] };
    expect(await first.json()).toEqual(body);
    expect(await second.json()).toEqual(body);
    expect(reads).toBe(1);
  });

  it("answers 502 when the chain cannot be read, 404 for other paths and 405 for other methods", async () => {
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      keeper: { health: () => healthAfter, dueNow: () => Promise.reject(new Error("fetch failed")) },
      log: silentLogger,
    });
    expect((await fetch(`${server.url}/due`)).status).toBe(502);
    expect((await fetch(`${server.url}/`)).status).toBe(404);
    const post = await fetch(`${server.url}/due`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});
