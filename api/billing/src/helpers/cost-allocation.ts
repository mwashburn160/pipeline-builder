// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost allocation (showback) — apportion a root account's billed actuals across
 * its child orgs/teams by a usage driver (default: seats). This is SHOWBACK,
 * not a separate charge: the money is invoiced once at the root; this only
 * distributes it for visibility. See docs/billing-discounts.md.
 *
 * Every money field (gross, discount, credit, tax, net) is apportioned by the
 * same per-child share using LARGEST-REMAINDER rounding, so the allocated cents
 * sum EXACTLY to the root total (no rounding leakage). A zero-usage child gets
 * $0; a period with zero total usage leaves everything on the root line.
 */

export interface AllocationTotals {
  grossBilledCents: number;
  discountsCents: number;
  creditsCents: number;
  taxCents: number;
  netBilledCents: number;
}

export interface AllocationChild {
  orgId: string;
  driverUnits: number;
}

export interface AllocationRow {
  orgId: string;
  driverUnits: number;
  sharePct: number;
  grossCents: number;
  discountCents: number;
  creditCents: number;
  taxCents: number;
  netCents: number;
}

export interface AllocationResult {
  driver: string;
  totals: AllocationTotals;
  rows: AllocationRow[];
  /** Cost not attributed to any child (the full total when there is zero usage). */
  unallocated: AllocationTotals;
}

/**
 * Apportion `total` across `weights` using largest-remainder, guaranteeing the
 * result sums to exactly `total`. Returns all-zero when the weights sum to 0.
 */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let remainder = total - floors.reduce((s, f) => s + f, 0);
  // Hand the leftover cents to the largest fractional parts first.
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) floors[order[k].i]++;
  return floors;
}

const zeroTotals = (): AllocationTotals => ({
  grossBilledCents: 0, discountsCents: 0, creditsCents: 0, taxCents: 0, netBilledCents: 0,
});

/**
 * Allocate `totals` across `children` by `driverUnits`. `driver` is a label for
 * the payload (e.g. "seats"). Discounts, credits, tax, and net are apportioned
 * proportionally by the same share as gross, so each child's NET is meaningful.
 */
export function allocateCosts(totals: AllocationTotals, children: AllocationChild[], driver: string): AllocationResult {
  const weights = children.map((c) => Math.max(0, c.driverUnits));
  const totalUnits = weights.reduce((s, w) => s + w, 0);

  const gross = apportion(totals.grossBilledCents, weights);
  const discount = apportion(totals.discountsCents, weights);
  const credit = apportion(totals.creditsCents, weights);
  const tax = apportion(totals.taxCents, weights);
  const net = apportion(totals.netBilledCents, weights);

  const rows: AllocationRow[] = children.map((c, i) => ({
    orgId: c.orgId,
    driverUnits: weights[i],
    sharePct: totalUnits > 0 ? Number(((weights[i] / totalUnits) * 100).toFixed(2)) : 0,
    grossCents: gross[i],
    discountCents: discount[i],
    creditCents: credit[i],
    taxCents: tax[i],
    netCents: net[i],
  }));

  // Whatever wasn't attributed (the whole total when totalUnits === 0).
  const allocated = rows.reduce((acc, r) => ({
    grossBilledCents: acc.grossBilledCents + r.grossCents,
    discountsCents: acc.discountsCents + r.discountCents,
    creditsCents: acc.creditsCents + r.creditCents,
    taxCents: acc.taxCents + r.taxCents,
    netBilledCents: acc.netBilledCents + r.netCents,
  }), zeroTotals());
  const unallocated: AllocationTotals = {
    grossBilledCents: totals.grossBilledCents - allocated.grossBilledCents,
    discountsCents: totals.discountsCents - allocated.discountsCents,
    creditsCents: totals.creditsCents - allocated.creditsCents,
    taxCents: totals.taxCents - allocated.taxCents,
    netBilledCents: totals.netBilledCents - allocated.netBilledCents,
  };

  return { driver, totals, rows, unallocated };
}
