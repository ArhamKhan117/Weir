import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiRequestError } from "./api";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number, body = "") => new Response(body, { status: code });

function stubFetch(...answers: (Response | Error)[]) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const next = answers.shift();
      if (next === undefined) throw new Error("no more answers");
      if (next instanceof Error) throw next;
      return next;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the API client", () => {
  it("retries a read through a dropped connection and a busy server", async () => {
    vi.useFakeTimers();
    const calls = stubFetch(new TypeError("network"), status(503), ok({ vaults: [] }));
    const pending = api.savingsVaults();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ vaults: [] });
    expect(calls).toHaveLength(3);
  });

  it("gives up on a read after three attempts", async () => {
    vi.useFakeTimers();
    stubFetch(status(500), status(500), status(500));
    const pending = api.savingsVaults().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(ApiRequestError);
  });

  it("never repeats a write the API may have taken in", async () => {
    const calls = stubFetch(new TypeError("network"));
    await expect(api.action({} as never)).rejects.toMatchObject({ code: "unreachable" });
    expect(calls).toHaveLength(1);
    const again = stubFetch(status(500, JSON.stringify({ error: { code: "internal", message: "boom" } })));
    await expect(api.action({} as never)).rejects.toMatchObject({ status: 500 });
    expect(again).toHaveLength(1);
  });

  it("repeats a write the API turned away unread", async () => {
    vi.useFakeTimers();
    const calls = stubFetch(status(429), ok({ transaction: "0xabc" }));
    const pending = api.action({} as never);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ transaction: "0xabc" });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.startsWith("POST ") && call.endsWith("/v1/relay/action"))).toBe(true);
  });

  it("explains a page that is not the API answering", async () => {
    stubFetch(status(502, "<html>Bad gateway</html>"), status(502, "<html>Bad gateway</html>"), status(502, "<html>Bad gateway</html>"));
    vi.useFakeTimers();
    const pending = api.savingsVaults().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ code: "unavailable" });
  });
});
