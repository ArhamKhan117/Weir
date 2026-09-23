/**
 * Which webhook URLs a merchant may set.
 *
 * The API POSTs to whatever a merchant names, from inside whatever network it runs in, so the URL
 * is the one input here that can point the server at something it should not reach. The policy:
 * an absolute http(s) URL with no credentials in it, https only on Mainnet, and outside local
 * development no loopback, private, link-local or `localhost`-style host. Redirects are never
 * followed at delivery, so a public host cannot bounce a delivery inward either.
 *
 * What this does not stop is a public hostname whose DNS answers with a private address. Closing
 * that needs resolution pinned at connect time, which belongs in the deployment's egress rules.
 */

import { isIP } from "node:net";

import { badRequest } from "../http/errors.js";

export interface WebhookUrlPolicy {
  /** Only `https:`. */
  requireHttps: boolean;
  /** Allow loopback and private hosts, for a merchant developing against a local receiver. */
  allowPrivateHosts: boolean;
}

export const MAX_WEBHOOK_URL = 2_048;

function privateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function privateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) return privateIpv4(mapped[1]);
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return true;
  const family = isIP(host);
  if (family === 4) return privateIpv4(host);
  if (family === 6) return privateIpv6(host);
  return false;
}

/** The URL, normalized, or a 400 saying why it is refused. */
export function validateWebhookUrl(raw: string, policy: WebhookUrlPolicy): string {
  if (raw.length > MAX_WEBHOOK_URL) throw badRequest(`webhookUrl must be at most ${MAX_WEBHOOK_URL} characters`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest("webhookUrl must be an absolute URL");
  }
  const allowed = policy.requireHttps ? ["https:"] : ["https:", "http:"];
  if (!allowed.includes(url.protocol)) {
    throw badRequest(policy.requireHttps ? "webhookUrl must use https" : "webhookUrl must use http or https");
  }
  if (url.username !== "" || url.password !== "") throw badRequest("webhookUrl must not carry credentials");
  if (url.hash !== "") throw badRequest("webhookUrl must not carry a fragment");
  if (!policy.allowPrivateHosts && isPrivateHost(url.hostname)) {
    throw badRequest("webhookUrl must point at a public host");
  }
  return url.toString();
}
