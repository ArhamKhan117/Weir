import { meterDomain, usageReceiptTypedData } from "@weir/shared";
import { METER_REASONS, meterPaymentPayload, meterRequirement, type MeterOffer } from "@weir/x402";
import { getAddress, verifyTypedData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { MeterStore, periodStartAt } from "../db/meters.js";
import { openTestDatabase } from "../test/db.js";
import { Facilitator } from "./facilitator.js";

const CHAIN = 10143;
const METER = getAddress("0x00000000000000000000000000000000000000a1");
const ASSET = getAddress("0x00000000000000000000000000000000000000b1");
const MERCHANT = getAddress("0x00000000000000000000000000000000000000c1");
const CREATED = 1_800_000_000;
const DAY = 86_400;

const db = await openTestDatabase("facilitator");

describe("periods", () => {
  it("start on the meter's own boundaries", () => {
    expect(periodStartAt(CREATED, DAY, CREATED)).toBe(CREATED);
    expect(periodStartAt(CREATED, DAY, CREATED + DAY - 1)).toBe(CREATED);
    expect(periodStartAt(CREATED, DAY, CREATED + 3 * DAY + 5)).toBe(CREATED + 3 * DAY);
  });
});

describe.skipIf(db === undefined)("the weir-meter facilitator", () => {
  const sql = db!.sql;
  const payer = privateKeyToAccount(generatePrivateKey());
  const session = privateKeyToAccount(generatePrivateKey());
  const store = new MeterStore(sql, { chainId: CHAIN, meter: METER }, () => "tAUSD");
  let now = CREATED + 100;
  let funds = { balance: 10_000_000n, allowance: 10_000_000n };

  const facilitator = new Facilitator({
    chainId: CHAIN,
    meter: METER,
    name: "Weir",
    version: "1",
    assets: [ASSET],
    store,
    verifySignature: (args) => verifyTypedData(args),
    funds: async () => funds,
    now: () => now,
  });

  const offer = (price = 1_000n): MeterOffer => ({
    chainId: CHAIN,
    asset: ASSET,
    payTo: MERCHANT,
    price,
    maxTimeoutSeconds: 60,
    meter: METER,
    name: "Weir",
    version: "1",
    facilitator: "https://api.test",
  });

  async function insertMeter(overrides: Partial<{ id: number; merchant: Address; status: string; closedAt: number; periodCap: bigint; maxTotal: bigint; expiresAt: number; totalCharged: bigint }> = {}) {
    await sql`
      INSERT INTO meters (chain_id, meter, id, payer, merchant, asset, manager, period_cap, period, max_total, expires_at, ref, status,
                          total_charged, closed_at, created_at, created_block, created_tx, needs_refresh)
      VALUES (${CHAIN}, ${METER}, ${overrides.id ?? 1}, ${payer.address}, ${overrides.merchant ?? MERCHANT}, ${ASSET}, ${session.address},
              ${(overrides.periodCap ?? 5_000n).toString()}, ${DAY}, ${(overrides.maxTotal ?? 8_000n).toString()},
              ${overrides.expiresAt ?? CREATED + 30 * DAY}, ${"0x" + "00".repeat(32)}, ${overrides.status ?? "Active"},
              ${(overrides.totalCharged ?? 0n).toString()}, ${overrides.closedAt ?? 0}, ${CREATED}, 1, ${"0x" + "11".repeat(32)}, false)`;
  }

  async function body(input: { total: bigint; price?: bigint; meterId?: bigint; signer?: typeof session; issuedAt?: number }) {
    const o = offer(input.price);
    const meterId = input.meterId ?? 1n;
    const issuedAt = BigInt(input.issuedAt ?? now);
    const signature: Hex = await (input.signer ?? session).signTypedData(
      usageReceiptTypedData({ domain: meterDomain({ name: "Weir", chainId: CHAIN, address: METER }), receipt: { meterId, total: input.total, issuedAt } }),
    );
    const requirement = meterRequirement(o);
    return {
      x402Version: 2,
      paymentPayload: meterPaymentPayload({ requirement, payment: { meterId, total: input.total, issuedAt, signature }, resource: { url: "https://api.test/fx" } }),
      paymentRequirements: requirement,
    };
  }

  beforeEach(async () => {
    await db!.reset();
    now = CREATED + 100;
    funds = { balance: 10_000_000n, allowance: 10_000_000n };
    await insertMeter();
  });

  afterAll(async () => {
    await db?.close();
  });

  it("verifies, then records, each request as the next running total", async () => {
    expect(await facilitator.verify(await body({ total: 1_000n }))).toEqual({ isValid: true, payer: payer.address });
    const settled = await facilitator.settle(await body({ total: 1_000n }));
    expect(settled).toMatchObject({ success: true, payer: payer.address, amount: "1000", extra: { total: "1000", meterId: "1" } });
    expect(await facilitator.settle(await body({ total: 2_000n }))).toMatchObject({ success: true });
    expect(await store.usage(1n)).toEqual({ total: 2_000n, periodStart: CREATED, periodUsed: 2_000n });
    const detail = await store.detail(1n, now);
    expect(detail?.calls).toBe(2);
    expect(detail?.recentCalls.map((c) => [c.total, c.amount, c.resource])).toEqual([
      ["2000", "1000", "https://api.test/fx"],
      ["1000", "1000", "https://api.test/fx"],
    ]);
  });

  it("accepts the payer's own key as well as the manager's", async () => {
    expect(await facilitator.settle(await body({ total: 1_000n, signer: payer }))).toMatchObject({ success: true });
  });

  it("refuses a total that is not exactly the last plus the price", async () => {
    await facilitator.settle(await body({ total: 1_000n }));
    for (const total of [1_000n, 1_500n, 3_000n]) {
      expect(await facilitator.verify(await body({ total }))).toMatchObject({ isValid: false, invalidReason: METER_REASONS.staleTotal });
    }
  });

  it("lets only one of two racing requests on the same base through", async () => {
    const [a, b] = await Promise.all([facilitator.settle(await body({ total: 1_000n })), facilitator.settle(await body({ total: 1_000n, signer: payer }))]);
    expect([a.success, b.success].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.success)?.errorReason).toBe(METER_REASONS.staleTotal);
    expect((await store.usage(1n))?.total).toBe(1_000n);
  });

  it("holds the period cap, and opens a new period on the meter's boundary", async () => {
    for (let i = 1n; i <= 5n; i += 1n) expect(await facilitator.settle(await body({ total: i * 1_000n }))).toMatchObject({ success: true });
    expect(await facilitator.verify(await body({ total: 6_000n }))).toMatchObject({ invalidReason: METER_REASONS.periodCap });
    now = CREATED + DAY;
    expect(await facilitator.settle(await body({ total: 6_000n }))).toMatchObject({ success: true });
    expect(await store.usage(1n)).toMatchObject({ periodStart: CREATED + DAY, periodUsed: 1_000n });
  });

  it("holds the lifetime cap", async () => {
    await sql`UPDATE meters SET period_cap = 8000 WHERE id = 1`;
    for (let i = 1n; i <= 8n; i += 1n) await facilitator.settle(await body({ total: i * 1_000n }));
    expect(await facilitator.verify(await body({ total: 9_000n }))).toMatchObject({ invalidReason: METER_REASONS.totalCap });
  });

  it("refuses a receipt that is not from just now", async () => {
    expect(await facilitator.verify(await body({ total: 1_000n, issuedAt: now - 61 }))).toMatchObject({ invalidReason: METER_REASONS.receiptTime });
    expect(await facilitator.verify(await body({ total: 1_000n, issuedAt: now + 6 }))).toMatchObject({ invalidReason: METER_REASONS.receiptTime });
  });

  it("refuses a stranger's receipt before saying anything about the meter's usage", async () => {
    await sql`UPDATE meters SET period_cap = 1 WHERE id = 1`;
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect(await facilitator.verify(await body({ total: 1_000n, signer: stranger }))).toMatchObject({ invalidReason: METER_REASONS.badSignature });
  });

  it("refuses unknown, stopped, expired and someone else's meters", async () => {
    expect(await facilitator.verify(await body({ total: 1_000n, meterId: 9n }))).toMatchObject({ invalidReason: METER_REASONS.unknownMeter });

    await insertMeter({ id: 2, status: "Cancelled", closedAt: now - 10 });
    expect(await facilitator.verify(await body({ total: 1_000n, meterId: 2n }))).toMatchObject({ invalidReason: METER_REASONS.notOpen });

    await insertMeter({ id: 3, expiresAt: now - 1 });
    expect(await facilitator.verify(await body({ total: 1_000n, meterId: 3n }))).toMatchObject({ invalidReason: METER_REASONS.notOpen });

    await insertMeter({ id: 4, merchant: getAddress("0x00000000000000000000000000000000000000c2") });
    expect(await facilitator.verify(await body({ total: 1_000n, meterId: 4n }))).toMatchObject({ invalidReason: METER_REASONS.wrongMerchant });
  });

  it("refuses when the payer cannot cover what is not yet settled", async () => {
    funds = { balance: 999n, allowance: 10_000n };
    expect(await facilitator.verify(await body({ total: 1_000n }))).toMatchObject({ invalidReason: METER_REASONS.unfunded });
    funds = { balance: 10_000n, allowance: 999n };
    expect(await facilitator.verify(await body({ total: 1_000n }))).toMatchObject({ invalidReason: METER_REASONS.unfunded });
  });

  it("counts from what is settled when nothing was accepted here", async () => {
    await sql`UPDATE meters SET total_charged = 3000 WHERE id = 1`;
    expect(await facilitator.verify(await body({ total: 1_000n }))).toMatchObject({ invalidReason: METER_REASONS.staleTotal });
    expect(await facilitator.settle(await body({ total: 4_000n }))).toMatchObject({ success: true });
  });

  it("refuses malformed bodies and offers for another meter", async () => {
    expect(await facilitator.verify({})).toMatchObject({ isValid: false, invalidReason: METER_REASONS.malformed });
    const good = await body({ total: 1_000n });
    const otherMeter = { ...good, paymentRequirements: meterRequirement({ ...offer(), meter: getAddress("0x00000000000000000000000000000000000000a9") }) };
    otherMeter.paymentPayload = { ...otherMeter.paymentPayload, accepted: otherMeter.paymentRequirements };
    expect(await facilitator.verify(otherMeter)).toMatchObject({ isValid: false, invalidReason: METER_REASONS.malformed });
    const mismatched = { ...good, paymentRequirements: meterRequirement(offer(2_000n)) };
    expect(await facilitator.verify(mismatched)).toMatchObject({ isValid: false, invalidReason: METER_REASONS.malformed });
  });

  it("finds a key's open meters for a payee, newest first", async () => {
    await insertMeter({ id: 2, status: "Cancelled", closedAt: now - 1 });
    const meters = await store.forSigner(session.address, MERCHANT, ASSET, now);
    expect(meters.map((m) => m.id)).toEqual(["1"]);
    expect(await store.forSigner(getAddress("0x00000000000000000000000000000000000000ff"), MERCHANT, ASSET, now)).toEqual([]);
  });
});
