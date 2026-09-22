/**
 * Every failure the API answers with, as `{ error: { code, message } }` and a status.
 *
 * Routes throw an {@link ApiHttpError}; the app's error handler turns it into the body. Anything
 * else thrown is logged and answered as a bare `internal`, so an unexpected message, which might
 * carry a request URL or a node's reply, never reaches a client.
 */

import type { ApiError, ApiErrorCode } from "@weir/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiHttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "ApiHttpError";
  }

  body(): ApiError {
    return { error: { code: this.code, message: this.message } };
  }
}

export const badRequest = (message: string): ApiHttpError => new ApiHttpError(400, "bad_request", message);

export const unauthorized = (message: string): ApiHttpError => new ApiHttpError(401, "unauthorized", message);

export const notFound = (message: string): ApiHttpError => new ApiHttpError(404, "not_found", message);

export const notConfigured = (message: string): ApiHttpError => new ApiHttpError(503, "not_configured", message);

export const rejectedOnChain = (message: string): ApiHttpError => new ApiHttpError(422, "rejected_on_chain", message);

/** `retry-after` is whole seconds, at least one, so a client never retries in a tight loop. */
export function rateLimited(message: string, retryAfterSeconds: number): ApiHttpError {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return new ApiHttpError(429, "rate_limited", message, { "retry-after": String(seconds) });
}

export const internal = (message = "Something went wrong on our side"): ApiHttpError =>
  new ApiHttpError(500, "internal", message);
