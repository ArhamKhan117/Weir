import { createHmac } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { silentLogger } from "../log.js";
import { openTestDatabase } from "../test/db.js";
import { WebhookDispatcher } from "./dispatcher.js";
import { newWebhookSecret, signWebhook, verifyWebhookSignature } from "./sign.js";
import { isPrivateHost, validateWebhookUrl } from "./url.js";

describe("webhook signatures", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1","type":"charge.succeeded"}';

  it("is HMAC-SHA256 over `<t>.<raw body>`, in a t=,v1= header", () => {
    const header = signWebhook(secret, body, 1_800_000_000);
    const expected = createHmac("sha256", secret).update(`1800000000.${body}`).digest("hex");
    expect(header).toBe(`t=1800000000,v1=${expected}`);
  });

  it("verifies, and refuses a changed body, a changed t, another secret and a stale t", () => {
    const header = signWebhook(secret, body, 1_800_000_000);
    expect(verifyWebhookSignature(secret, body, header, 1_800_000_010)).toBe(true);
    expect(verifyWebhookSignature(secret, `${body} `, header, 1_800_000_010)).toBe(false);
    expect(verifyWebhookSignature(secret, body, header.replace("t=1800000000", "t=1800000001"), 1_800_000_010)).toBe(false);
    expect(verifyWebhookSignature("whsec_other", body, header, 1_800_000_010)).toBe(false);
    expect(verifyWebhookSignature(secret, body, header, 1_800_000_000 + 301)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined, 1_800_000_000)).toBe(false);
    expect(verifyWebhookSignature(secret, body, "v1=zz", 1_800_000_000)).toBe(false);
  });

  it("mints distinct secrets", () => {
    const a = newWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(newWebhookSecret()).not.toBe(a);
  });
});

describe("webhook URLs", () => {
  const open = { requireHttps: false, allowPrivateHosts: false };

  it("takes public http(s) URLs and refuses the rest", () => {
    expect(validateWebhookUrl("https://example.com/hooks", { requireHttps: true, allowPrivateHosts: false })).toBe("https://example.com/hooks");
    expect(() => validateWebhookUrl("http://example.com/hooks", { requireHttps: true, allowPrivateHosts: false })).toThrow(/must use https/);
    expect(() => validateWebhookUrl("ftp://example.com", open)).toThrow(/http or https/);
    expect(() => validateWebhookUrl("https://user:pass@example.com", open)).toThrow(/credentials/);
    expect(() => validateWebhookUrl("not a url", open)).toThrow(/absolute URL/);
  });

  it("refuses private and loopback hosts unless developing locally", () => {
    for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "[::1]", "[fd00::1]", "api.internal", "0.0.0.0"]) {
      expect(isPrivateHost(host.replace(/^\[|\]$/g, ""))).toBe(true);
      expect(() => validateWebhookUrl(`http://${host}/x`, open)).toThrow(/public host/);
    }
    expect(isPrivateHost("172.32.0.1")).toBe(false);
    expect(validateWebhookUrl("http://127.0.0.1:9000/x", { requireHttps: false, allowPrivateHosts: true })).toBe("http://127.0.0.1:9000/x");
  });
});

const db = await openTestDatabase("webhooks");

describe.skipIf(db === undefined)("webhook delivery", () => {
  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db?.reset();
  });

  async function seed(url: string | null): Promise<void> {
    const sql = db!.sql;
    await sql`INSERT INTO merchants (id, auth_subject, name, webhook_url, webhook_since, webhook_secret, created_at)
              VALUES ('mer_a', 'dev:a', 'A', ${url}, 0, 'whsec_seed', 0)`;
    await sql`INSERT INTO webhook_deliveries (merchant_id, event_id, event_type, body, next_attempt_ms, created_ms)
              VALUES ('mer_a', 'evt_1', 'charge.succeeded', '{"id":"evt_1"}', 0, 0)`;
  }

  async function delivery() {
    const [row] = await db!.sql<{ status: string; attempts: number; next_attempt_ms: string; last_status: number | null; last_error: string | null; last_url: string | null }[]>`
      SELECT status, attempts, next_attempt_ms, last_status, last_error, last_url FROM webhook_deliveries WHERE event_id = 'evt_1'`;
    return row!;
  }

  it("POSTs the stored body, signed with the merchant's secret, and records the delivery", async () => {
    await seed("https://merchant.example/hooks");
    const seen: { url: string; body: string; signature: string | null }[] = [];
    const now = 1_800_000_000_000;
    const dispatcher = new WebhookDispatcher({
      sql: db!.sql,
      logger: silentLogger,
      now: () => now,
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(url), body: String(init?.body), signature: headers.get("Weir-Signature") });
        return new Response("ok", { status: 200 });
      },
    });
    expect(await dispatcher.runOnce()).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toBe('{"id":"evt_1"}');
    expect(verifyWebhookSignature("whsec_seed", seen[0]!.body, seen[0]!.signature, now / 1000)).toBe(true);
    expect(await delivery()).toMatchObject({ status: "delivered", attempts: 1, last_status: 200, last_url: "https://merchant.example/hooks" });
    expect(await dispatcher.runOnce()).toEqual({ delivered: 0, retried: 0, failed: 0 });
  });

  it("retries with backoff three times, then gives up", async () => {
    await seed("https://merchant.example/hooks");
    let now = 1_000_000;
    let calls = 0;
    const dispatcher = new WebhookDispatcher({
      sql: db!.sql,
      logger: silentLogger,
      now: () => now,
      backoffMs: [10_000, 60_000, 300_000],
      fetch: async () => {
        calls += 1;
        return new Response("no", { status: 500 });
      },
    });

    expect(await dispatcher.runOnce()).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect(await delivery()).toMatchObject({ status: "pending", attempts: 1, next_attempt_ms: String(now + 10_000), last_status: 500, last_error: "HTTP 500" });

    now += 9_999;
    expect(await dispatcher.runOnce()).toEqual({ delivered: 0, retried: 0, failed: 0 });
    now += 1;
    expect(await dispatcher.runOnce()).toEqual({ delivered: 0, retried: 1, failed: 0 });
    expect((await delivery()).next_attempt_ms).toBe(String(now + 60_000));
    now += 60_000;
    expect(await dispatcher.runOnce()).toEqual({ delivered: 0, retried: 1, failed: 0 });
    now += 300_000;
    expect(await dispatcher.runOnce()).toEqual({ delivered: 0, retried: 0, failed: 1 });
    expect(await delivery()).toMatchObject({ status: "failed", attempts: 4 });
    expect(calls).toBe(4);
    now += 10_000_000;
    expect(await dispatcher.runOnce()).toEqual({ delivered: 0, retried: 0, failed: 0 });
  });

  it("treats a network error or a redirect as a failed attempt, and a removed webhook as final", async () => {
    await seed("https://merchant.example/hooks");
    const dispatcher = new WebhookDispatcher({
      sql: db!.sql,
      logger: silentLogger,
      now: () => 0,
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(await dispatcher.runOnce()).toMatchObject({ retried: 1 });
    expect((await delivery()).last_error).toBe("connect ECONNREFUSED");

    await db!.reset();
    await seed(null);
    expect(await dispatcher.runOnce()).toMatchObject({ failed: 1 });
    expect(await delivery()).toMatchObject({ status: "failed", last_error: "the webhook was removed" });

    await db!.reset();
    await seed("https://merchant.example/hooks");
    const redirected = new WebhookDispatcher({
      sql: db!.sql,
      logger: silentLogger,
      now: () => 0,
      fetch: async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    });
    expect(await redirected.runOnce()).toMatchObject({ retried: 1 });
    expect((await delivery()).last_status).toBe(302);
  });
});
