// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the cost-allocation (showback) math (Phase 8). Pure — no mocks.
 * The key invariants: allocated cents sum EXACTLY to the root total (no rounding
 * leakage), discounts/credits/net are apportioned by the same share, and the
 * zero-usage edges leave cost on the root line.
 */

import { describe, it, expect } from '@jest/globals';
import { allocateCosts, type AllocationTotals } from '../src/helpers/cost-allocation.js';

const totals = (over: Partial<AllocationTotals> = {}): AllocationTotals => ({
  grossBilledCents: 10000, discountsCents: 0, creditsCents: 2000, taxCents: 0, netBilledCents: 8000, ...over,
});

const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0);

describe('allocateCosts', () => {
  it('apportions net proportionally by driver units', () => {
    const r = allocateCosts(totals(), [{ orgId: 'a', driverUnits: 3 }, { orgId: 'b', driverUnits: 1 }], 'seats');
    expect(r.rows.map((x) => x.netCents)).toEqual([6000, 2000]); // 3:1 of 8000
    expect(r.rows.map((x) => x.grossCents)).toEqual([7500, 2500]);
    expect(r.rows[0].sharePct).toBe(75);
  });

  it('sums allocated cents EXACTLY to the total (largest-remainder, no leakage)', () => {
    // 10000 across 3 equal shares is 3333.33… — largest-remainder must still total 10000.
    const r = allocateCosts(totals({ grossBilledCents: 10000, netBilledCents: 10000, creditsCents: 0 }),
      [{ orgId: 'a', driverUnits: 1 }, { orgId: 'b', driverUnits: 1 }, { orgId: 'c', driverUnits: 1 }], 'seats');
    expect(sum(r.rows.map((x) => x.grossCents))).toBe(10000);
    expect(sum(r.rows.map((x) => x.netCents))).toBe(10000);
    // The extra cent lands on exactly one child.
    expect(r.rows.map((x) => x.grossCents).sort()).toEqual([3333, 3333, 3334]);
    expect(r.unallocated.grossBilledCents).toBe(0);
  });

  it('gives a zero-usage child $0', () => {
    const r = allocateCosts(totals(), [{ orgId: 'a', driverUnits: 4 }, { orgId: 'z', driverUnits: 0 }], 'seats');
    expect(r.rows[1]).toMatchObject({ orgId: 'z', grossCents: 0, netCents: 0, sharePct: 0 });
    expect(r.rows[0].netCents).toBe(8000);
  });

  it('leaves everything unallocated when total usage is zero', () => {
    const r = allocateCosts(totals(), [{ orgId: 'a', driverUnits: 0 }, { orgId: 'b', driverUnits: 0 }], 'seats');
    expect(r.rows.every((x) => x.grossCents === 0 && x.netCents === 0)).toBe(true);
    expect(r.unallocated.grossBilledCents).toBe(10000);
    expect(r.unallocated.netBilledCents).toBe(8000);
  });

  it('allocates 100% to a single-org account', () => {
    const r = allocateCosts(totals(), [{ orgId: 'root', driverUnits: 7 }], 'seats');
    expect(r.rows[0]).toMatchObject({ orgId: 'root', grossCents: 10000, creditCents: 2000, netCents: 8000, sharePct: 100 });
    expect(r.unallocated.grossBilledCents).toBe(0);
  });
});
