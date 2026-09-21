/**
 * The gas limit the relayer states.
 *
 * Monad bills the gas limit, not the gas used, and its receipts report `gasUsed` equal to the
 * limit, so every unit of margin is paid on every transaction. The limit is the estimate plus 5%
 * and 5,000 gas, rounded up: enough to absorb the drift between estimation and inclusion, and no
 * more. The floor is the cost of any transaction at all; the ceiling is Monad's per-transaction
 * cap, which also bounds what one relayed call can ever cost.
 */

export const GAS_MARGIN_PERCENT = 5n;
export const GAS_MARGIN_FIXED = 5_000n;
export const GAS_FLOOR = 21_000n;
export const GAS_CEILING = 30_000_000n;

export function gasLimitFor(estimate: bigint): bigint {
  const padded = (estimate * (100n + GAS_MARGIN_PERCENT) + 99n) / 100n + GAS_MARGIN_FIXED;
  if (padded < GAS_FLOOR) return GAS_FLOOR;
  if (padded > GAS_CEILING) return GAS_CEILING;
  return padded;
}
