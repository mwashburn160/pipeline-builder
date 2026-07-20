// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { getTierLimits } from '@pipeline-builder/api-core';
import type { BundleConfig } from '../src/config/config-types.js';
import { effectiveEntitlements } from '../src/config/entitlements.js';

// Assertions are relative to the live `getTierLimits` base so they hold even if
// a QUOTA_TIER_* env override is present.
const bundle = (over: Partial<BundleConfig> & Pick<BundleConfig, 'id' | 'grants'>): BundleConfig => ({
  name: over.id,
  description: '',
  prices: { monthly: 0, annual: 0 },
  stackable: true,
  availableForTiers: ['pro'],
  isActive: true,
  sortOrder: 0,
  ...over,
});

const bundles: BundleConfig[] = [
  bundle({ id: 'seat_pack', grants: { seats: 5 } }),
  bundle({ id: 'pipeline_pack', grants: { pipelines: 10 } }),
  bundle({ id: 'audit_log', grants: {}, features: ['audit_log'], stackable: false }),
];

describe('effectiveEntitlements', () => {
  it('returns the tier base with no add-ons', () => {
    const { limits, features } = effectiveEntitlements('developer', [], bundles);
    expect(limits.seats).toBe(getTierLimits('developer').seats);
    expect(features).toEqual([]);
  });

  it('adds stacked grants (3× seat_pack ⇒ +15 seats over the base)', () => {
    const base = getTierLimits('developer').seats;
    const { limits } = effectiveEntitlements('developer', [{ bundleId: 'seat_pack', quantity: 3 }], bundles);
    expect(limits.seats).toBe(base + 15);
  });

  it('sums grants across different bundles', () => {
    const dev = getTierLimits('developer');
    const { limits } = effectiveEntitlements('developer', [
      { bundleId: 'seat_pack', quantity: 1 },
      { bundleId: 'pipeline_pack', quantity: 2 },
    ], bundles);
    expect(limits.seats).toBe(dev.seats + 5);
    expect(limits.pipelines).toBe(dev.pipelines + 20);
  });

  it('unions feature-bundle flags and ignores unknown bundles', () => {
    const dev = getTierLimits('developer');
    const { limits, features } = effectiveEntitlements('developer', [
      { bundleId: 'audit_log', quantity: 1 },
      { bundleId: 'nope', quantity: 5 },
    ], bundles);
    expect(features).toContain('audit_log');
    expect(limits.seats).toBe(dev.seats); // unchanged
  });

  it('leaves an already-unlimited (-1) field unlimited', () => {
    // Team apiCalls is unlimited (-1); an api-granting bundle must not turn it
    // into a finite number.
    const apiBundle = [bundle({ id: 'api_pack', grants: { apiCalls: 1_000_000 } })];
    expect(getTierLimits('team').apiCalls).toBe(-1);
    const { limits } = effectiveEntitlements('team', [{ bundleId: 'api_pack', quantity: 4 }], apiBundle);
    expect(limits.apiCalls).toBe(-1);
  });

  it('ignores non-positive quantities', () => {
    const dev = getTierLimits('developer');
    const { limits } = effectiveEntitlements('developer', [{ bundleId: 'seat_pack', quantity: 0 }], bundles);
    expect(limits.seats).toBe(dev.seats);
  });
});
