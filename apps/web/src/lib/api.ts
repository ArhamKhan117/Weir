/**
 * The typed client for the Weir API. Every request and response shape is from `@weir/shared`, so
 * the web app and the API cannot drift apart without the build noticing.
 */

import {
  API_ROUTES,
  type ActionRequest,
  type ApiError,
  type CheckoutResponse,
  type CreatePlanRequest,
  type FaucetResponse,
  type InstallRequest,
  type InstallResponse,
  type MerchantOverview,
  type MerchantProfile,
  type MerchantAnalytics,
  type PayerResponse,
  type PayoutInfo,
  type PayoutRequest,
  type PayoutResponse,
  type Plan,
  type RelayResponse,
  type CreateSupportRequest,
  type PushKeyResponse,
  type PushSubscribeRequest,
  type PushUnsubscribeRequest,
  type SavingsRequest,
  type SavingsResponse,
  type StatsResponse,
  type SupportCircle,
  type SupporterNameRequest,
  type SupportListResponse,
  type SupportResponse,
  type UpdateMerchantRequest,
} from "@weir/shared";
import type { Address } from "viem";

import { API_URL } from "./config";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const ATTEMPTS = 3;
const BACKOFF_MS = [400, 1_200];

/**
 * Whether a failed attempt may be repeated. Reads repeat on anything passing: a dropped
 * connection, a busy server, a gateway between us and the API. A write repeats only when the API
 * never took it in (a rate limit, or a gateway answering that the API is unavailable), so a relayed
 * transaction is never sent twice.
 */
function retryable(method: string, status: number): boolean {
  const read = method === "GET";
  if (status === 0) return read;
  if (status === 429 || status === 502 || status === 503) return true;
  return read && status >= 500;
}

function waitBefore(attempt: number, response: Response | undefined): Promise<void> {
  const after = Number(response?.headers.get("retry-after"));
  const ms = Number.isFinite(after) && after > 0 ? Math.min(after * 1_000, 5_000) : (BACKOFF_MS[attempt] ?? 2_000);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request<T>(path: string, init: RequestInit & { auth?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.auth !== undefined) headers.set("authorization", init.auth);
  const method = (init.method ?? "GET").toUpperCase();

  for (let attempt = 0; ; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetch(`${API_URL}${path}`, { ...init, headers });
    } catch {
      response = undefined;
    }
    const status = response?.status ?? 0;
    if (response?.ok !== true && attempt + 1 < ATTEMPTS && retryable(method, status)) {
      await waitBefore(attempt, response);
      continue;
    }
    if (response === undefined) {
      throw new ApiRequestError(0, "unreachable", "Weir's servers could not be reached. Check your connection and try again.");
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      // Not the API answering: a proxy or host error page.
      throw new ApiRequestError(response.status, "unavailable", "Weir is not answering right now. Please try again in a moment.");
    }
    if (!response.ok) {
      const error = (body as ApiError | undefined)?.error;
      throw new ApiRequestError(response.status, error?.code ?? "internal", error?.message ?? `Request failed (${response.status})`);
    }
    return body as T;
  }
}

const json = (value: unknown) => JSON.stringify(value);

export const api = {
  checkout: (planId: string) => request<CheckoutResponse>(API_ROUTES.checkout(planId)),
  install: (body: InstallRequest) => request<InstallResponse>(API_ROUTES.install, { method: "POST", body: json(body) }),
  action: (body: ActionRequest) => request<RelayResponse>(API_ROUTES.action, { method: "POST", body: json(body) }),
  faucet: (address: Address) => request<FaucetResponse>(API_ROUTES.faucet, { method: "POST", body: json({ address }) }),
  payer: (address: Address) => request<PayerResponse>(API_ROUTES.payer(address)),
  savingsVaults: () => request<SavingsResponse>(API_ROUTES.savingsVaults),
  savings: (body: SavingsRequest) => request<RelayResponse>(API_ROUTES.savings, { method: "POST", body: json(body) }),
  pushKey: () => request<PushKeyResponse>(API_ROUTES.pushKey),
  subscribePush: (body: PushSubscribeRequest) =>
    request<{ subscribed: boolean }>(API_ROUTES.pushSubscriptions, { method: "POST", body: json(body) }),
  unsubscribePush: (body: PushUnsubscribeRequest) =>
    request<undefined>(API_ROUTES.pushSubscriptions, { method: "DELETE", body: json(body) }),
  openSupport: (body: CreateSupportRequest) => request<SupportCircle>(API_ROUTES.support, { method: "POST", body: json(body) }),
  support: (id: string) => request<SupportResponse>(API_ROUTES.supportCircle(id)),
  supportFor: (recipient: Address) => request<SupportListResponse>(API_ROUTES.supportFor(recipient)),
  nameSupporter: (id: string, mandateId: string, body: SupporterNameRequest) =>
    request<{ name: string }>(API_ROUTES.supporterName(id, mandateId), { method: "PUT", body: json(body) }),

  merchantOverview: (auth: string) => request<MerchantOverview>(API_ROUTES.merchantOverview, { auth }),
  updateMerchant: (auth: string, body: UpdateMerchantRequest) =>
    request<MerchantProfile & { webhookSecret?: string }>(API_ROUTES.merchant, { method: "PUT", body: json(body), auth }),
  createPlan: (auth: string, body: CreatePlanRequest) =>
    request<Plan>(API_ROUTES.plans, { method: "POST", body: json(body), auth }),
  merchantAnalytics: (auth: string) => request<MerchantAnalytics>(API_ROUTES.merchantAnalytics, { auth }),
  stats: () => request<StatsResponse>(API_ROUTES.stats),
  payoutInfo: (auth: string) => request<PayoutInfo>(API_ROUTES.payout, { auth }),
  payout: (auth: string, body: PayoutRequest) => request<PayoutResponse>(API_ROUTES.payout, { method: "POST", body: json(body), auth }),
  setPlanActive: (auth: string, planId: string, active: boolean) =>
    request<Plan>(API_ROUTES.plan(planId), { method: "PATCH", body: json({ active }), auth }),
};
