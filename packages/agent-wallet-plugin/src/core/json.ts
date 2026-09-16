/**
 * Values as plain JSON: every `bigint` becomes its decimal string, the way the Weir API writes
 * amounts, so a dry run's typed data can be read back by any JSON consumer without losing digits.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [key, inner] of Object.entries(value)) {
      if (inner !== undefined) out[key] = toJson(inner);
    }
    return out;
  }
  return null;
}
