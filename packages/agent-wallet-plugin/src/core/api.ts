/**
 * The typed client for the Weir API. Every request and response shape comes from `@weir/shared`,
 * so the plugin and the API cannot drift apart without the typecheck noticing.
 *
 * Failures become {@link WeirError}s that say which API was asked and what it answered: a refusal
 * on chain is named ("the hub refused it: MandateExpired"), a rate limit says when to retry, and an
 * API that does not answer at all says where it was looked for.
 */

import {
  API_ROUTES,
  type ActionRequest,
  type ApiError,
  type CheckoutResponse,
  type FaucetResponse,
  type InstallRequest,
  type InstallResponse,
  type PayerResponse,
  type RelayResponse,
  type SavingsRequest,
  type SavingsResponse,
} from "@weir/shared";
import type { Address } from "viem";

import { describeRefusal, WeirError } from "./errors.js";

/** The fields of `GET /health` the plugin reads. */
export interface HealthInfo {
  chainId: number;
  hub: Address;
}

export interface WeirApi {
  readonly baseUrl: string;
  checkout(planId: string): Promise<CheckoutResponse>;
  health(): Promise<HealthInfo>;
  payer(address: Address): Promise<PayerResponse>;
  savingsVaults(): Promise<SavingsResponse>;
  install(body: InstallRequest): Promise<InstallResponse>;
  action(body: ActionRequest): Promise<RelayResponse>;
  savings(body: SavingsRequest): Promise<RelayResponse>;
  faucet(address: Address): Promise<FaucetResponse>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Reads answer from the index; relays wait for the transaction's receipt, which takes longer. */
const READ_TIMEOUT_MS = 30_000;
const RELAY_TIMEOUT_MS = 120_000;

interface Call {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** Answers that carry a usable body despite a failing status, as `/health` does on 503. */
  acceptStatus?: readonly number[];
  /** What a 404 means for this route, when it means something more specific than "not found". */
  notFound?: () => WeirError;
}

export function createApi(baseUrl: string, fetchImpl: Fetch = fetch): WeirApi {
  async function call<T>({ method, path, body, acceptStatus = [], notFound }: Call): Promise<T> {
    const url = `${baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(method === "GET" ? READ_TIMEOUT_MS : RELAY_TIMEOUT_MS),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new WeirError(
        "API_UNREACHABLE",
        timedOut ? `The Weir API at ${baseUrl} did not answer ${method} ${path} in time` : `The Weir API at ${baseUrl} could not be reached`,
        timedOut && method === "POST"
          ? "The relay may still land. Check `mm weir list` before trying again."
          : "Start it with `pnpm api` in the Weir repository, or point --api or WEIR_API_URL at a running one.",
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      throw new WeirError("API_ERROR", `The Weir API at ${baseUrl} answered ${method} ${path} with something other than JSON (${response.status})`, "Check that --api or WEIR_API_URL points at the Weir API, not the web app.");
    }
    if (response.ok || acceptStatus.includes(response.status)) return parsed as T;
    if (response.status === 404 && notFound !== undefined) throw notFound();
    throw failure(response, parsed, baseUrl, `${method} ${path}`);
  }

  return {
    baseUrl,
    checkout: (planId) =>
      call({
        method: "GET",
        path: API_ROUTES.checkout(planId),
        notFound: () =>
          new WeirError("PLAN_NOT_FOUND", `No plan ${planId} at the Weir API at ${baseUrl}`, "Check the link, or ask the business for a new one. A plan lives on one API; --api picks which."),
      }),
    health: async () => {
      const answer = await call<Partial<HealthInfo> | undefined>({ method: "GET", path: API_ROUTES.health, acceptStatus: [503] });
      if (typeof answer?.chainId !== "number" || typeof answer.hub !== "string") {
        throw new WeirError("API_ERROR", `The Weir API at ${baseUrl} did not say which chain it serves`, "Check that --api or WEIR_API_URL points at the Weir API.");
      }
      return { chainId: answer.chainId, hub: answer.hub as Address };
    },
    payer: (address) => call({ method: "GET", path: API_ROUTES.payer(address) }),
    savingsVaults: () => call({ method: "GET", path: API_ROUTES.savingsVaults }),
    install: (body) => call({ method: "POST", path: API_ROUTES.install, body }),
    action: (body) => call({ method: "POST", path: API_ROUTES.action, body }),
    savings: (body) => call({ method: "POST", path: API_ROUTES.savings, body }),
    faucet: (address) =>
      call({
        method: "POST",
        path: API_ROUTES.faucet,
        body: { address },
        notFound: () => new WeirError("NOT_TESTNET", `The Weir API at ${baseUrl} has no faucet`, "Test dollars exist on Monad Testnet only."),
      }),
  };
}

/** The error an API failure becomes, from its status and `{ error: { code, message } }` body. */
export function failure(response: Pick<Response, "status" | "headers">, body: unknown, baseUrl: string, what: string): WeirError {
  const error = (body as ApiError | undefined)?.error;
  const message = typeof error?.message === "string" ? error.message : `${what} failed with status ${response.status}`;
  switch (error?.code) {
    case "rejected_on_chain": {
      const refusal = describeRefusal(message);
      return new WeirError(refusal.code, refusal.message, refusal.hint);
    }
    case "not_found":
      return new WeirError("API_REFUSED", message, "Check the id, or run `mm weir list`.");
    case "bad_request":
      return new WeirError("API_REFUSED", `The Weir API refused the request: ${message}`, "Nothing was sent to the chain. Fix the input and try again.");
    case "rate_limited": {
      const retry = response.headers.get("retry-after");
      return new WeirError("RATE_LIMITED", message, `Wait ${retry === null ? "a few" : retry} seconds and try again.`);
    }
    case "not_configured":
      return new WeirError("RELAYER_UNAVAILABLE", message, "The API cannot submit transactions right now. Try again later, or ask whoever runs it.");
    default:
      if (response.status === 504) {
        return new WeirError("RECEIPT_PENDING", message, "The transaction was sent and may still land. Check `mm weir list` before trying again.");
      }
      return new WeirError("API_ERROR", `The Weir API at ${baseUrl} failed ${what}: ${message}`, "Try again. If it keeps failing, check the API's logs.");
  }
}
