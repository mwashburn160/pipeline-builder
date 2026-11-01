// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { getTierLimits } from '@pipeline-builder/api-core';
import type { BundleConfig } from '../src/config/billing-types.js';
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
  bundle({ id: 'custom_integrations', grants: {}, features: ['custom_integrations'], stackable: false }),
  // The support levels: stackable (the quantity IS the contact count) AND
  // feature-granting, which no other bundle in the real catalog is.
  bundle({ id: 'support_standard', grants: { supportContacts: 1 }, features: ['support_standard'] }),
  bundle({ id: 'support_priority', grants: { supportContacts: 1 }, features: ['support_priority'] }),
  bundle({ id: 'support_premium', grants: { supportContacts: 1 }, features: ['support_premium'] }),
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
      { bundleId: 'custom_integrations', quantity: 1 },
      { bundleId: 'nope', quantity: 5 },
    ], bundles);
    expect(features).toContain('custom_integrations');
    expect(limits.seats).toBe(dev.seats); // unchanged
  });

  it('leaves an already-unlimited (-1) field unlimited', () => {
    // Enterprise idpConfigs is unlimited (-1); an idp-granting bundle must not
    // turn it into a finite number.
    const idpBundle = [bundle({ id: 'idp_pack', grants: { idpConfigs: 5 } })];
    expect(getTierLimits('enterprise').idpConfigs).toBe(-1);
    const { limits } = effectiveEntitlements('enterprise', [{ bundleId: 'idp_pack', quantity: 4 }], idpBundle);
    expect(limits.idpConfigs).toBe(-1);
  });

  it('ignores non-positive quantities', () => {
    const dev = getTierLimits('developer');
    const { limits } = effectiveEntitlements('developer', [{ bundleId: 'seat_pack', quantity: 0 }], bundles);
    expect(limits.seats).toBe(dev.seats);
  });

  it('clamps a non-stackable bundle to quantity 1 even if a larger qty is stored', () => {
    // A non-stackable bundle with an idpConfigs:5 grant — a stored quantity>1
    // must NOT over-grant (the canonical math enforces the invariant, not just
    // the purchase route). Fixture ids only: the shipped catalog has no
    // non-stackable bundle carrying a quota grant since `sso` was withdrawn, and
    // the clamp is a property of the math, not of any one SKU.
    const dev = getTierLimits('developer');
    const idpBundle = [bundle({ id: 'idp_pack', grants: { idpConfigs: 5 }, features: ['advanced_reporting'], stackable: false })];
    const { limits, features } = effectiveEntitlements('developer', [{ bundleId: 'idp_pack', quantity: 3 }], idpBundle);
    expect(limits.idpConfigs).toBe(dev.idpConfigs + 5); // +5, not +15
    expect(features).toContain('advanced_reporting');
  });

  it('clamps a stackable bundle to its maxQuantity even if a larger qty is stored', () => {
    // A retention pack caps at maxQuantity 7; a stored/drifted qty of 20 must NOT
    // grant 20×90 days (which would blow past the retention ceiling the cap holds).
    const dev = getTierLimits('developer');
    const capped = [bundle({ id: 'retention_pack', grants: { eventRetentionDays: 90 }, maxQuantity: 7 })];
    const { limits } = effectiveEntitlements('developer', [{ bundleId: 'retention_pack', quantity: 20 }], capped);
    expect(limits.eventRetentionDays).toBe(dev.eventRetentionDays + 7 * 90); // clamped to 7, not 20
  });
});

/**
 * Support levels are MUTUALLY EXCLUSIVE, and `winningSupportLevel` is the only
 * thing enforcing it.
 *
 * `BundleConfig` has `stackable` and `requires` but no notion of exclusion, so
 * without this an account that holds two levels — a drift, or a mistaken
 * purchase — gets both flags and its contacts summed across them. That is a
 * customer paying $25.97/contact for one level of service, and an entitlement
 * set no support path can act on coherently.
 *
 * Enforced in the CANONICAL math rather than only at the purchase route,
 * because the drift reconciler and the subscription-lifecycle sync both compute
 * entitlements from stored state they did not validate.
 */
describe('support levels are mutually exclusive', () => {
  it('keeps only the BEST level when two are held', () => {
    const { features } = effectiveEntitlements('pro', [
      { bundleId: 'support_standard', quantity: 2 },
      { bundleId: 'support_premium', quantity: 3 },
    ], bundles);
    expect(features).toContain('support_premium');
    expect(features).not.toContain('support_standard');
  });

  it('drops the loser CONTACTS too, not just its flag', () => {
    // The deliberate part: a double purchase is a billing error to resolve, not
    // a reason to inflate the contact allowance into a number that corresponds
    // to nothing purchasable. 2 + 3 would be 5; only the winner's 3 count.
    const base = getTierLimits('pro').supportContacts;
    const { limits } = effectiveEntitlements('pro', [
      { bundleId: 'support_standard', quantity: 2 },
      { bundleId: 'support_premium', quantity: 3 },
    ], bundles);
    expect(limits.supportContacts).toBe(base + 3);
  });

  it('resolves precedence in BOTH orders — the result cannot depend on addon order', () => {
    const a = effectiveEntitlements('pro', [
      { bundleId: 'support_premium', quantity: 1 },
      { bundleId: 'support_standard', quantity: 1 },
    ], bundles);
    const b = effectiveEntitlements('pro', [
      { bundleId: 'support_standard', quantity: 1 },
      { bundleId: 'support_premium', quantity: 1 },
    ], bundles);
    expect(a.features.sort()).toEqual(b.features.sort());
    expect(a.limits.supportContacts).toBe(b.limits.supportContacts);
  });

  it('picks priority over standard', () => {
    const { features } = effectiveEntitlements('pro', [
      { bundleId: 'support_standard', quantity: 1 },
      { bundleId: 'support_priority', quantity: 1 },
    ], bundles);
    expect(features).toEqual(expect.arrayContaining(['support_priority']));
    expect(features).not.toContain('support_standard');
  });

  it('a single level is unaffected, and its quantity IS the contact count', () => {
    const base = getTierLimits('pro').supportContacts;
    const { features, limits } = effectiveEntitlements('pro', [
      { bundleId: 'support_priority', quantity: 4 },
    ], bundles);
    expect(features).toEqual(['support_priority']);
    expect(limits.supportContacts).toBe(base + 4);
  });

  it('ignores a level held at quantity 0 when choosing the winner', () => {
    // A removed-but-still-stored add-on must not beat a live one.
    const { features } = effectiveEntitlements('pro', [
      { bundleId: 'support_premium', quantity: 0 },
      { bundleId: 'support_standard', quantity: 2 },
    ], bundles);
    expect(features).toEqual(['support_standard']);
  });

  it('is the catalog FIRST bundle that is both stackable and feature-granting', () => {
    // Every other feature bundle is `stackable: false`. The combination works
    // because `features` unions into a Set independent of quantity while
    // `grants` scales with it — asserted here because nothing else covers it.
    const { features, limits } = effectiveEntitlements('pro', [
      { bundleId: 'support_standard', quantity: 3 },
    ], bundles);
    expect(features).toEqual(['support_standard']);
    expect(limits.supportContacts).toBe(getTierLimits('pro').supportContacts + 3);
  });
});
