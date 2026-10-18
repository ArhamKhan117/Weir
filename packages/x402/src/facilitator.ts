/**
 * Talking to a facilitator over HTTP: JSON in, JSON out, a bounded wait.
 */

const TIMEOUT_MS = 15_000;

export class FacilitatorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FacilitatorError";
  }
}

async function readJson<T>(response: Response, url: string): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    throw new FacilitatorError(response.status, `${url} did not answer with JSON`);
  }
  // A verify or settle refusal is a 200 with `isValid: false` or `success: false`; anything else
  // that is not 2xx is the facilitator failing.
  if (!response.ok) {
    const message = (body as { error?: { message?: string } } | undefined)?.error?.message ?? `HTTP ${response.status}`;
    throw new FacilitatorError(response.status, `${url}: ${message}`);
  }
  return body as T;
}

export async function postFacilitator<T>(fetchImpl: typeof fetch, url: string, body: unknown): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return readJson<T>(response, url);
}

export async function getFacilitator<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  return readJson<T>(response, url);
}
