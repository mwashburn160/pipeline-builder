// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for WHERE a feature lock sends the viewer.
 *
 * `featureUpsellHref` branches on `FEATURE_GATES[flag].acquiredVia`, and both
 * halves of that branch fail SILENTLY when the declaration is wrong:
 *
 *  - A tier-only flag declared `bundle` yields `?highlight=<flag>`, which
 *    AddonGrid matches against bundle ids/names/features. Nothing matches, so it
 *    highlights nothing and scrolls nowhere — the viewer lands on an add-on grid
 *    that never mentions the thing they clicked. That is exactly what `sso` did
 *    once the Pro-only SSO bundle was withdrawn.
 *  - A purchasable flag declared `tier` sends a buyer to the Plans tab and tells
 *    them to upgrade, when a $30 pack would have done.
 *
 * Neither throws, neither is visible in a screenshot, and neither shows up in a
 * component test that mocks the gate. So the declarations are checked against
 * the two files that actually decide them: api-core's `TIER_FEATURES` (which
 * tier includes what) and pipeline-core's bundle catalog (what is on sale).
 * Both are read as SOURCE TEXT — the frontend deliberately doesn't import
 * api-core (Express/JWT server code) and doesn't depend on pipeline-core at all,
 * which is the same approach `feature-flags-parity.test.ts` takes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_FEATURE_FLAGS, type FeatureFlag } from '../src/lib/feature-flags';
import { FEATURE_GATES, featureUpsellHref, featureUpsellCta, featureUpsellTrailer, featureUpsellAdvice } from '../src/lib/feature-gates';

const apiCoreCatalog = readFileSync(
  resolve(__dirname, '../../packages/api-core/src/types/feature-flags.ts'), 'utf8',
);
const bundleCatalog = readFileSync(
  resolve(__dirname, '../../packages/pipeline-core/src/config/billing-config.ts'), 'utf8',
);

/** Sellable plans, cheapest first. `unlimited` is the billing-off tier and is
 *  never a plan anyone is told to upgrade to, so it is left out. */
const PLAN_ORDER = ['developer', 'pro', 'team', 'enterprise'] as const;
const PLAN_LABEL: Record<(typeof PLAN_ORDER)[number], string> = {
  developer: 'Developer', pro: 'Pro', team: 'Team', enterprise: 'Enterprise',
};

/**
 * The flags one tier of api-core's `TIER_FEATURES` grants. `[...ALL_FEATURE_FLAGS]`
 * (enterprise / unlimited) means every flag.
 */
function tierFeatures(tier: string): Set<string> {
  const m = new RegExp(`\\n\\s*${tier}:\\s*\\[([^\\]]*)\\]`).exec(apiCoreCatalog);
  if (!m) throw new Error(`TIER_FEATURES.${tier} not found — the extraction regex needs updating`);
  if (m[1].includes('...ALL_FEATURE_FLAGS')) return new Set(ALL_FEATURE_FLAGS);
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

/** The cheapest sellable plan whose TIER_FEATURES include `flag`, or null. */
function lowestPlanIncluding(flag: FeatureFlag): string | null {
  const tier = PLAN_ORDER.find((t) => tierFeatures(t).has(flag));
  return tier ? PLAN_LABEL[tier] : null;
}

/** Whether any bundle in the shipped catalog grants `flag`. */
function isSoldAsBundle(flag: FeatureFlag): boolean {
  return new RegExp(`features:\\s*\\['${flag}'\\]`).test(bundleCatalog);
}

describe('feature-gate upsell routing', () => {
  it('reads both source catalogs (guards against a vacuously passing extraction)', () => {
    // A regex that stopped matching would make every assertion below trivially
    // true, which is worse than failing.
    expect(tierFeatures('pro').size).toBeGreaterThan(0);
    expect(tierFeatures('enterprise').size).toBe(ALL_FEATURE_FLAGS.length);
    expect(tierFeatures('developer').size).toBe(0);
    expect(bundleCatalog).toContain("b('advanced_reporting'");
  });

  it.each([...ALL_FEATURE_FLAGS])('%s declares how it is acquired', (flag: FeatureFlag) => {
    expect(['bundle', 'tier']).toContain(FEATURE_GATES[flag].acquiredVia);
  });

  it.each([...ALL_FEATURE_FLAGS])('%s is declared `bundle` exactly when a bundle sells it', (flag: FeatureFlag) => {
    // The whole point: a flag with no bundle behind it must not deep-link to one.
    expect(FEATURE_GATES[flag].acquiredVia === 'bundle').toBe(isSoldAsBundle(flag));
  });

  it.each([...ALL_FEATURE_FLAGS])('%s names the right plan when it is tier-only', (flag: FeatureFlag) => {
    const spec = FEATURE_GATES[flag];
    if (spec.acquiredVia !== 'tier') {
      expect(spec.includedFrom).toBeUndefined();
      return;
    }
    // The lock renders this string verbatim ("included from the Team plan"), so
    // it has to be the cheapest plan that actually grants the flag.
    expect(spec.includedFrom).toBe(lowestPlanIncluding(flag));
  });

  it('routes a tier-only flag to Plans and a purchasable one to its add-on card', () => {
    expect(featureUpsellHref('sso')).toBe('/dashboard/billing?tab=plans');
    expect(featureUpsellHref('bulk_operations')).toBe('/dashboard/billing?tab=plans');
    expect(featureUpsellHref('advanced_reporting')).toBe('/dashboard/billing?highlight=advanced_reporting');
    expect(featureUpsellHref('compliance_advanced')).toBe('/dashboard/billing?highlight=compliance_advanced');
  });

  it('never offers to "add" a feature that cannot be added', () => {
    // The CTA and its trailing clause form one sentence; "add it to your plan"
    // on a tier feature sends the reader looking for a pack that isn't on sale.
    expect(featureUpsellCta('sso')).toBe('Compare plans');
    expect(featureUpsellTrailer('sso')).not.toMatch(/add it/i);
    expect(featureUpsellAdvice('sso')).toMatch(/upgrading the plan/i);

    expect(featureUpsellCta('advanced_reporting')).toBe('See it in Billing');
    expect(featureUpsellTrailer('advanced_reporting')).toMatch(/add it to your plan/i);
    expect(featureUpsellAdvice('advanced_reporting')).toMatch(/add it to your plan/i);
  });

  it('keeps `sso` a Team-and-above tier feature with no SKU behind it', () => {
    // The decision this file's routing depends on, asserted at both ends.
    expect(FEATURE_GATES.sso.acquiredVia).toBe('tier');
    expect(FEATURE_GATES.sso.includedFrom).toBe('Team');
    expect(tierFeatures('pro').has('sso')).toBe(false);
    expect(tierFeatures('team').has('sso')).toBe(true);
    expect(isSoldAsBundle('sso')).toBe(false);
  });
});
