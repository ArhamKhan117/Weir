/**
 * Step two: read the whole working set in one Multicall3 call and decide, per mandate, whether
 * to charge it now, wait, or drop it for good.
 *
 * The read takes `getMandate`, `isChargeable` and `quoteCharge` for every id, plus Multicall3's
 * own block number and timestamp, so every decision is made against the chain's clock at the
 * block the state came from, never the keeper's. `isChargeable` deliberately ignores funding:
 * a past-due mandate is still chargeable and is retried, which is how it recovers when the
 * payer tops up.
 *
 * Periodic mandates are charged as soon as they are chargeable. A stream accrues every second,
 * so charging it every block would spend more gas than it collects; it is charged when one of
 * these holds, whichever comes first:
 *
 * - its quote reaches `streamMinCharge` base units;
 * - its quote has reached what one charge may take (`maxPerCharge`, or what `maxTotal` has
 *   left), because accrual above the per-charge cap is forfeited rather than carried, and
 *   waiting any longer only loses it;
 * - `streamMaxAgeSeconds` have passed since its checkpoint;
 * - it is within two keeper intervals of `expiresAt`, since nothing can be charged after it.
 *
 * Dropping is for states that can never become chargeable again: an unknown id, a cancelled
 * mandate (cancellation is absorbing), an expired one (`expiresAt` never moves), and a spent one
 * (`totalCharged` only grows and `maxTotal` never moves).
 */

import { parseAbi, zeroAddress, type Address, type ContractFunctionParameters, type PublicClient } from "viem";
import { isStreaming, mandateHubAbi, mandateStatusFromIndex, standingOf, type MandateRecord } from "@weir/shared";

/**
 * Ids per Multicall3 call. Measured on Monad Testnet at about 22,000 gas an id, so a full call
 * stays near 11M gas, well inside what an `eth_call` may use. A working set larger than this is
 * read in several calls, all pinned to the block of the first.
 */
export const IDS_PER_READ = 500;

/** Multicall3's own clock, read in the same call as the state so the two cannot disagree. */
const multicall3ClockAbi = parseAbi([
  "function getBlockNumber() view returns (uint256 blockNumber)",
  "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
]);

export interface MandateRead {
  readonly id: bigint;
  readonly mandate: MandateRecord;
  readonly chargeable: boolean;
  /** Base units a charge would take now; zero when not chargeable. */
  readonly quote: bigint;
}

export interface ChainRead {
  readonly blockNumber: bigint;
  /** The block's timestamp, the clock every decision uses. */
  readonly timestamp: bigint;
  readonly mandates: MandateRead[];
}

/** `getMandate`'s struct as viem decodes it. */
interface RawMandate {
  payer: Address;
  nextChargeAt: bigint;
  period: number;
  merchant: Address;
  expiresAt: bigint;
  status: number;
  asset: Address;
  amount: bigint;
  manager: Address;
  maxPerCharge: bigint;
  maxTotal: bigint;
  totalCharged: bigint;
  pausedAt: bigint;
  vault: Address;
}

export interface ReadOptions {
  readonly hub: Address;
  readonly multicall: Address;
  readonly ids: readonly bigint[];
  readonly idsPerRead?: number;
}

/**
 * Every id's state and the chain clock. A failed call anywhere throws: an unreadable working set
 * must never look like one with nothing due.
 */
export async function readMandates(client: Pick<PublicClient, "multicall">, options: ReadOptions): Promise<ChainRead> {
  const { hub, multicall, ids } = options;
  const size = options.idsPerRead ?? IDS_PER_READ;
  const clock: ContractFunctionParameters[] = [
    { address: multicall, abi: multicall3ClockAbi, functionName: "getBlockNumber" },
    { address: multicall, abi: multicall3ClockAbi, functionName: "getCurrentBlockTimestamp" },
  ];
  const callsFor = (id: bigint): ContractFunctionParameters[] => [
    { address: hub, abi: mandateHubAbi, functionName: "getMandate", args: [id] },
    { address: hub, abi: mandateHubAbi, functionName: "isChargeable", args: [id] },
    { address: hub, abi: mandateHubAbi, functionName: "quoteCharge", args: [id] },
  ];
  const call = async (contracts: ContractFunctionParameters[], blockNumber?: bigint): Promise<unknown[]> =>
    (await client.multicall({
      contracts,
      allowFailure: false,
      multicallAddress: multicall,
      // Zero lifts viem's default 1 KiB calldata split, which would turn one read into dozens.
      batchSize: 0,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    })) as unknown[];

  const first = ids.slice(0, size);
  const [blockNumber, timestamp, ...firstResults] = await call([...clock, ...first.flatMap(callsFor)]);
  if (typeof blockNumber !== "bigint" || typeof timestamp !== "bigint") {
    throw new Error("Multicall3 did not return the block number and timestamp");
  }
  const results = firstResults;
  for (let start = size; start < ids.length; start += size) {
    results.push(...(await call(ids.slice(start, start + size).flatMap(callsFor), blockNumber)));
  }

  const mandates = ids.map((id, index): MandateRead => {
    const raw = results[index * 3] as RawMandate | undefined;
    const chargeable = results[index * 3 + 1];
    const quote = results[index * 3 + 2];
    if (raw === undefined || typeof chargeable !== "boolean" || typeof quote !== "bigint") {
      throw new Error(`the state read returned no answer for mandate ${id}`);
    }
    return { id, mandate: toRecord(id, raw), chargeable, quote };
  });
  return { blockNumber, timestamp, mandates };
}

function toRecord(id: bigint, raw: RawMandate): MandateRecord {
  return {
    id,
    payer: raw.payer,
    merchant: raw.merchant,
    asset: raw.asset,
    vault: raw.vault,
    manager: raw.manager,
    amount: raw.amount,
    period: raw.period,
    nextChargeAt: raw.nextChargeAt,
    maxPerCharge: raw.maxPerCharge,
    maxTotal: raw.maxTotal,
    totalCharged: raw.totalCharged,
    expiresAt: raw.expiresAt,
    pausedAt: raw.pausedAt,
    status: mandateStatusFromIndex(raw.status),
  };
}

/*//////////////////////////////////////////////////////////////
                           DUE SELECTION
//////////////////////////////////////////////////////////////*/

export interface DuePolicy {
  readonly streamMinCharge: bigint;
  readonly streamMaxAgeSeconds: bigint;
  /** Seconds between passes, rounded up. The near-expiry window is two of these. */
  readonly intervalSeconds: bigint;
}

export type ChargeReason = "periodic" | "min-charge" | "capped" | "max-age" | "near-expiry";
export type WaitReason = "not-due" | "paused" | "accruing";
export type DropReason = "unknown" | "cancelled" | "expired" | "completed";

export type Verdict =
  | { readonly action: "charge"; readonly reason: ChargeReason }
  | { readonly action: "wait"; readonly reason: WaitReason }
  | { readonly action: "drop"; readonly reason: DropReason };

/** What to do with one mandate at chain time `now`. */
export function judge(read: MandateRead, now: bigint, policy: DuePolicy): Verdict {
  const m = read.mandate;
  if (m.payer === zeroAddress) return { action: "drop", reason: "unknown" };

  const standing = standingOf(m, now);
  if (standing === "Cancelled") return { action: "drop", reason: "cancelled" };
  if (standing === "Expired") return { action: "drop", reason: "expired" };
  if (standing === "Completed") return { action: "drop", reason: "completed" };
  if (m.pausedAt !== 0n) return { action: "wait", reason: "paused" };
  if (!read.chargeable || read.quote === 0n) return { action: "wait", reason: "not-due" };

  if (!isStreaming(m)) return { action: "charge", reason: "periodic" };

  if (read.quote >= policy.streamMinCharge) return { action: "charge", reason: "min-charge" };
  const left = m.maxTotal - m.totalCharged;
  if (read.quote >= (m.maxPerCharge < left ? m.maxPerCharge : left)) return { action: "charge", reason: "capped" };
  if (now - m.nextChargeAt >= policy.streamMaxAgeSeconds) return { action: "charge", reason: "max-age" };
  if (m.expiresAt - now <= 2n * policy.intervalSeconds) return { action: "charge", reason: "near-expiry" };
  return { action: "wait", reason: "accruing" };
}

export interface DueMandate {
  readonly read: MandateRead;
  readonly reason: ChargeReason;
}

export interface Selection {
  /** Ascending by id. */
  readonly due: DueMandate[];
  readonly waiting: Array<{ readonly id: bigint; readonly reason: WaitReason }>;
  readonly dropped: Array<{ readonly id: bigint; readonly reason: DropReason }>;
}

export function selectDue(read: ChainRead, policy: DuePolicy): Selection {
  const selection: Selection = { due: [], waiting: [], dropped: [] };
  for (const mandate of read.mandates) {
    const verdict = judge(mandate, read.timestamp, policy);
    if (verdict.action === "charge") selection.due.push({ read: mandate, reason: verdict.reason });
    else if (verdict.action === "wait") selection.waiting.push({ id: mandate.id, reason: verdict.reason });
    else selection.dropped.push({ id: mandate.id, reason: verdict.reason });
  }
  selection.due.sort((a, b) => (a.read.id < b.read.id ? -1 : a.read.id > b.read.id ? 1 : 0));
  return selection;
}
