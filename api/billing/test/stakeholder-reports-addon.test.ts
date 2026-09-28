// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Stakeholder Reports add-on across its whole billing life: purchase, lapse, resume
 * and upgrade. The plan's "Done when" for the billing phase names exactly these four.
 *
 * AGAINST THE REAL CATALOG, not a fixture — `addon-prune.test.ts` mocks the catalog down
 * to a handful of synthetic bundles, which is right for testing the prune ALGORITHM and
 * useless for testing whether THIS bundle is wired correctly. The distinction matters:
 * every assertion here would pass against a fake catalog while the shipped one granted
 * nothing.
 *
 * The feature is asserted through the EFFECTIVE feature set, because that is what every
 * consumer reads — the reporting service's per-run recheck, the entitlement push to
 * reporting, and the compose-time section gate all resolve the flag rather than inspect
 * the bundle list. Asserting the bundle alone would pass while the feature failed to
 * resolve.
 */

import { describe, it, expect } from '@jest/globals';
import { TIER_FEATURES } from '@pipeline-builder/api-core';

// `src/config.ts` refuses to load without a Mongo URI when billing is on, and every import
// below reaches it. Nothing here touches a database — the reads are pure catalog and tier
// arithmetic — so the URI only has to EXIST, not resolve. Set before the imports rather
// than beside them, because a static import would hoist above the assignment.
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-addon-lifecycle';

const { getBundleCatalog } = await import('../src/helpers/billing-helpers.js');
const { pruneTierIncludedFeatureAddons } = await import('../src/helpers/addon-prune.js');
const { effectiveFeatureSet } = await import('../src/helpers/entitlement-sync.js');

const held = [{ bundleId: 'stakeholder_reports', quantity: 1 }];

describe('the Stakeholder Reports add-on through purchase, lapse, resume and upgrade', () => {
  const catalog = getBundleCatalog();

  it('is in the shipped catalog, on Pro and Team, granting its feature', () => {
    const bundle = catalog.find((b) => b.id === 'stakeholder_reports');
    expect(bundle).toBeDefined();
    expect(bundle?.features).toEqual(['stakeholder_reports']);
    expect([...(bundle?.availableForTiers ?? [])].sort()).toEqual(['pro', 'team']);
    // Not stackable: one account cannot hold two, because the second buys nothing.
    expect(bundle?.stackable).toBe(false);
  });

  it('PURCHASE on Pro grants the feature', () => {
    expect(effectiveFeatureSet('pro', held)).toContain('stakeholder_reports');
  });

  it('PURCHASE on Team grants it too', () => {
    expect(effectiveFeatureSet('team', held)).toContain('stakeholder_reports');
  });

  it('LAPSE removes it — Pro and Team do not include it in the tier', () => {
    expect(effectiveFeatureSet('pro', [])).not.toContain('stakeholder_reports');
    expect(effectiveFeatureSet('team', [])).not.toContain('stakeholder_reports');
    // Stated at the source as well, so a tier-matrix edit that quietly gave the add-on
    // away for free fails HERE rather than in revenue.
    expect(TIER_FEATURES.pro).not.toContain('stakeholder_reports');
    expect(TIER_FEATURES.team).not.toContain('stakeholder_reports');
  });

  it('a lapsed Developer org never had it', () => {
    expect(effectiveFeatureSet('developer', [])).not.toContain('stakeholder_reports');
    // …and cannot buy it: the bundle is Pro+ only.
    expect(catalog.find((b) => b.id === 'stakeholder_reports')?.availableForTiers).not.toContain('developer');
  });

  it('RESUME grants it again, with no residue from the lapse', () => {
    expect(effectiveFeatureSet('team', held)).toContain('stakeholder_reports');
  });

  it('UPGRADE to Enterprise PRUNES the bundle, because the tier already includes it', () => {
    const { addons: kept, pruned } = pruneTierIncludedFeatureAddons(held, 'enterprise', catalog);
    // The customer must stop paying for a bundle their new tier gives them — the
    // double-billing this prune exists to prevent.
    expect(kept).toEqual([]);
    expect(pruned.map((p) => p.bundleId)).toEqual(['stakeholder_reports']);
    expect(pruned[0]?.features).toEqual(['stakeholder_reports']);
  });

  it('…and the upgraded account still HOLDS the feature after the prune', () => {
    const { addons: kept } = pruneTierIncludedFeatureAddons(held, 'enterprise', catalog);
    // The pairing that matters: prune the charge, keep the capability. Backwards, this
    // would pause every report the customer just paid MORE to keep.
    expect(effectiveFeatureSet('enterprise', kept)).toContain('stakeholder_reports');
  });

  it('is NOT pruned on Team, which does not include it', () => {
    const { addons: kept, pruned } = pruneTierIncludedFeatureAddons(held, 'team', catalog);
    expect(kept).toEqual(held);
    expect(pruned).toEqual([]);
  });

  it('is on for a billing-disabled install, which runs as the unlimited tier', () => {
    // No bundle held, because there is nothing to buy — which is why the upsell and the
    // free preview are both hidden in the UI for this case.
    expect(effectiveFeatureSet('unlimited', [])).toContain('stakeholder_reports');
  });

  it('rides the Analytics Suite combo, which prices all three members together', () => {
    // A customer who wants delivery analytics AND a way to show them to managers is
    // buying one thing; the combo is what says so.
    const bundle = catalog.find((b) => b.id === 'stakeholder_reports');
    expect(bundle?.prices.monthly).toBe(3000);
  });
});
