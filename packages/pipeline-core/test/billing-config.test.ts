// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest } from '@jest/globals';
import { VALID_TIERS } from '@pipeline-builder/api-core';
import { loadBillingConfig, assertBundleRequiresValid, assertCombosValid } from '../src/config/billing-config.js';
import type { BundleConfig, ComboDiscountConfig } from '../src/config/config-types.js';

/** Minimal BundleConfig factory for the requires-graph assertion tests. */
function mkBundle(id: string, overrides: Partial<BundleConfig> = {}): BundleConfig {
  return {
    id,
    name: id,
    description: id,
    grants: {},
    prices: { monthly: 1000, annual: 10000 },
    stackable: false,
    availableForTiers: ['pro'],
    isActive: true,
    sortOrder: 0,
    ...overrides,
  };
}

/** Minimal ComboDiscountConfig factory for the combo-member assertion tests. */
function mkCombo(id: string, bundleIds: string[], overrides: Partial<ComboDiscountConfig> = {}): ComboDiscountConfig {
  return {
    id,
    name: id,
    bundleIds,
    prices: { monthly: 1000, annual: 10000 },
    sortOrder: 0,
    isActive: true,
    ...overrides,
  };
}

describe('loadBillingConfig', () => {
  it('provides a plan for every QuotaTier', () => {
    const { plans } = loadBillingConfig();
    // The plan set is compile-bound to QuotaTier (Record<QuotaTier, …>), so this
    // guards the runtime shape: exactly one plan per tier, none missing/extra.
    const tiersWithPlans = plans.map((p) => p.tier).sort();
    expect(tiersWithPlans).toEqual([...VALID_TIERS].sort());
    for (const tier of VALID_TIERS) {
      expect(plans.filter((p) => p.tier === tier)).toHaveLength(1);
    }
  });

  it('emits plans in canonical tier order', () => {
    const { plans } = loadBillingConfig();
    expect(plans.map((p) => p.tier)).toEqual([...VALID_TIERS]);
  });

  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns all plans with correct defaults', () => {
    const config = loadBillingConfig();
    // Four selectable tiers + `unlimited` (billing-disabled default; seeded but
    // filtered out of the purchasable list by the billing read-plans route).
    expect(config.plans).toHaveLength(5);

    const [developer, pro, team, enterprise, unlimited] = config.plans;

    expect(developer).toMatchObject({
      id: 'developer',
      name: 'Developer',
      tier: 'developer',
      prices: { monthly: 0, annual: 0 },
      isDefault: true,
      sortOrder: 0,
    });

    expect(pro).toMatchObject({
      id: 'pro',
      name: 'Pro',
      tier: 'pro',
      prices: { monthly: 3900, annual: 39000 },
      isDefault: false,
      sortOrder: 1,
    });

    expect(team).toMatchObject({
      id: 'team',
      name: 'Team',
      tier: 'team',
      prices: { monthly: 7900, annual: 79000 },
      isDefault: false,
      sortOrder: 2,
    });

    expect(enterprise).toMatchObject({
      id: 'enterprise',
      name: 'Enterprise',
      tier: 'enterprise',
      prices: { monthly: 59900, annual: 599000 },
      isDefault: false,
      sortOrder: 3,
    });

    expect(unlimited).toMatchObject({
      id: 'unlimited',
      name: 'Unlimited',
      tier: 'unlimited',
      prices: { monthly: 0, annual: 0 },
      isDefault: false,
      sortOrder: 4,
    });
  });

  it('overrides prices from environment variables', () => {
    process.env.BILLING_PLAN_PRO_MONTHLY = '999';
    process.env.BILLING_PLAN_PRO_ANNUAL = '9990';

    const config = loadBillingConfig();
    const pro = config.plans.find((p) => p.id === 'pro');

    expect(pro?.prices).toEqual({ monthly: 999, annual: 9990 });
  });

  it('overrides description from environment variable', () => {
    process.env.BILLING_PLAN_DEVELOPER_DESCRIPTION = 'Custom description';

    const config = loadBillingConfig();
    const developer = config.plans.find((p) => p.id === 'developer');

    expect(developer?.description).toBe('Custom description');
  });

  it('overrides features from JSON environment variable', () => {
    process.env.BILLING_PLAN_ENTERPRISE_FEATURES = '["Feature A","Feature B"]';

    const config = loadBillingConfig();
    const enterprise = config.plans.find((p) => p.id === 'enterprise');

    expect(enterprise?.features).toEqual(['Feature A', 'Feature B']);
  });

  it('falls back to default features on invalid JSON', () => {
    process.env.BILLING_PLAN_DEVELOPER_FEATURES = 'not-valid-json';

    const config = loadBillingConfig();
    const developer = config.plans.find((p) => p.id === 'developer');

    expect(developer?.features).toContain('Up to 25 plugins');
  });

  it('falls back to default features when JSON is not an array', () => {
    process.env.BILLING_PLAN_PRO_FEATURES = '{"key": "value"}';

    const config = loadBillingConfig();
    const pro = config.plans.find((p) => p.id === 'pro');

    expect(pro?.features).toContain('Up to 50 plugins');
  });

  it('includes default features for each plan', () => {
    const config = loadBillingConfig();
    const [developer, pro, team, enterprise] = config.plans;

    expect(developer.features).toContain('Community support');
    expect(pro.features).toContain('Reporting dashboard');
    // Feature-flag-backed perks are derived from FEATURE_METADATA labels.
    expect(team.features).toContain('SSO / IdP');
    // No flag-backed perk the API doesn't enforce (the old `audit_log` flag gated nothing).
    expect(team.features).not.toContain('Audit Log');
    expect(enterprise.features).toContain('Custom Integrations');
    // Pro now advertises its enforced Priority Support entitlement (was wrongly
    // marketed as 'Community support' while TIER_FEATURES.pro grants priority_support).
    expect(pro.features).toContain('Priority Support');
    expect(pro.features).not.toContain('Community support');
    // SSO is INCLUDED in Team (TIER_FEATURES.team grants `sso`), so Team markets it
    // (derived from FEATURE_METADATA.sso.label). The Pro tier does NOT — and, since
    // the Pro-only SSO add-on was withdrawn, there is now no way for Pro to get it
    // at all short of upgrading. See the bundle-catalog test below.
    expect(team.features).toContain('SSO / IdP');
    expect(pro.features).not.toContain('SSO / IdP');
  });

  it('derives seat lines from tier limits', () => {
    const config = loadBillingConfig();
    const [developer, , team, enterprise] = config.plans;

    expect(developer.features).toContain('Up to 1 seat');
    expect(team.features).toContain('Up to 3 seats');
    expect(enterprise.features).toContain('Up to 15 seats');
  });

  describe('add-on bundles', () => {
    it('returns the default catalog with default prices + grants', () => {
      const { bundles } = loadBillingConfig();
      const seat = bundles.find((x) => x.id === 'seat');
      expect(seat).toMatchObject({
        id: 'seat',
        grants: { seats: 1 },
        prices: { monthly: 1999, annual: 19990 },
        stackable: true,
        volumeTiers: [
          { minQuantity: 5, discountPercent: 10 },
          { minQuantity: 15, discountPercent: 20 },
          { minQuantity: 40, discountPercent: 30 },
        ],
      });
      // Feature bundles carry a flag and no numeric grant.
      // Advanced Reporting (DORA) — a feature bundle for every non-Enterprise tier
      // (Enterprise gets it via TIER_FEATURES).
      const advReporting = bundles.find((x) => x.id === 'advanced_reporting');
      expect(advReporting).toMatchObject({
        id: 'advanced_reporting',
        grants: {},
        features: ['advanced_reporting'],
        prices: { monthly: 3000, annual: 30000 },
        stackable: false,
        availableForTiers: ['developer', 'pro', 'team'],
      });
    });

    it('sells no SSO add-on — `sso` is a Team-and-above TIER feature only', () => {
      // The withdrawn `sso` bundle was $40/mo on Pro only: Pro ($39) + add-on came
      // to exactly the Team price, and Team includes SSO anyway. It was also
      // unusable below Team — SSO needs a DNS-verified domain and domain
      // registration is itself a Team+ tier check, so a Pro buyer's non-Google IdP
      // failed at callback. Neither the id NOR the flag may come back as a SKU:
      // checking only the id would let a differently-named bundle re-sell it.
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'sso')).toBeUndefined();
      expect(bundles.filter((b) => (b.features ?? []).includes('sso'))).toEqual([]);
      // …and no bundle may depend on it either, which would be permanently
      // unsatisfiable below Team.
      expect(bundles.filter((b) => (b.requires ?? []).includes('sso'))).toEqual([]);
      expect(bundles.filter((b) => (b.requiresFeatures ?? []).includes('sso'))).toEqual([]);
    });

    it('lists no combo whose members are not all in the catalog', () => {
      // The real guard against a withdrawn bundle leaving a dangling combo.
      const { bundles, comboDiscounts } = loadBillingConfig();
      const ids = new Set(bundles.filter((b) => b.isActive).map((b) => b.id));
      for (const combo of comboDiscounts) {
        expect(combo.bundleIds.filter((id) => !ids.has(id))).toEqual([]);
      }
    });

    it('caps the retention packs at their maxQuantity (730-day retention ceiling)', () => {
      const { bundles } = loadBillingConfig();
      // Standard Retention Pack: 30 + 7×90 = 660 ≤ 730.
      expect(bundles.find((x) => x.id === 'retention_pack')?.maxQuantity).toBe(7);
      // DORA History Pack: 180 + 1×365 = 545 ≤ 730.
      expect(bundles.find((x) => x.id === 'dora_history_pack')?.maxQuantity).toBe(1);
      // Bundles without a cap leave maxQuantity absent (unbounded).
      expect(bundles.find((x) => x.id === 'seat')?.maxQuantity).toBeUndefined();
      expect(bundles.find((x) => x.id === 'pipeline_pack')?.maxQuantity).toBeUndefined();
    });

    it('overrides a bundle price from the environment', () => {
      process.env.BILLING_BUNDLE_SEAT_MONTHLY = '3000';
      process.env.BILLING_BUNDLE_SEAT_ANNUAL = '30000';
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'seat')?.prices).toEqual({ monthly: 3000, annual: 30000 });
    });

    it('overrides a single-dimension grant amount from the environment', () => {
      process.env.BILLING_BUNDLE_SEAT_GRANT = '2';
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'seat')?.grants).toEqual({ seats: 2 });
    });

    it('overrides seat volume tiers from BILLING_BUNDLE_SEAT_VOLUME_TIERS (sorted ascending)', () => {
      process.env.BILLING_BUNDLE_SEAT_VOLUME_TIERS = '[{"minQuantity":20,"discountPercent":25},{"minQuantity":8,"discountPercent":12}]';
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'seat')?.volumeTiers).toEqual([
        { minQuantity: 8, discountPercent: 12 },
        { minQuantity: 20, discountPercent: 25 },
      ]);
    });

    it('falls back to the default volume tiers on a malformed / non-monotonic override', () => {
      const cases = [
        'not-json',
        '[]',
        '[{"minQuantity":1.5,"discountPercent":10}]', // fractional minQuantity
        '[{"minQuantity":5,"discountPercent":30},{"minQuantity":15,"discountPercent":20}]', // descending pct
        '[{"minQuantity":5,"discountPercent":10},{"minQuantity":5,"discountPercent":20}]', // duplicate minQuantity
      ];
      const dflt = [
        { minQuantity: 5, discountPercent: 10 },
        { minQuantity: 15, discountPercent: 20 },
        { minQuantity: 40, discountPercent: 30 },
      ];
      for (const c of cases) {
        process.env.BILLING_BUNDLE_SEAT_VOLUME_TIERS = c;
        const { bundles } = loadBillingConfig();
        expect(bundles.find((x) => x.id === 'seat')?.volumeTiers).toEqual(dflt);
      }
    });

    it('ignores a malformed or negative grant override', () => {
      process.env.BILLING_BUNDLE_PIPELINE_PACK_GRANT = 'abc';
      process.env.BILLING_BUNDLE_PLUGIN_PACK_GRANT = '-5';
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'pipeline_pack')?.grants).toEqual({ pipelines: 5 });
      expect(bundles.find((x) => x.id === 'plugin_pack')?.grants).toEqual({ plugins: 25 });
    });

    it('ignores a grant override on a feature-only (empty-grant) bundle', () => {
      process.env.BILLING_BUNDLE_ADVANCED_REPORTING_GRANT = '99';
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'advanced_reporting')?.grants).toEqual({});
    });

    it('offers Team Usage Analytics only on Team (lower tiers cannot nest teams)', () => {
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'team_usage_analytics')?.availableForTiers).toEqual(['team']);
    });

    it('describes Advanced Reporting lead time as measured, not a proxy', () => {
      const { bundles } = loadBillingConfig();
      const desc = bundles.find((x) => x.id === 'advanced_reporting')?.description ?? '';
      expect(desc).not.toMatch(/proxy/i);
      expect(desc).toMatch(/lead time \(commit → deploy\)/);
    });

    it('makes the DORA History Pack require the advanced_reporting feature', () => {
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'dora_history_pack')?.requiresFeatures).toEqual(['advanced_reporting']);
    });

    it('keeps plugin/api/ai/storage packs all-tier, but restricts seat + pipeline_pack (tier differentiators) to Team+', () => {
      const { bundles } = loadBillingConfig();
      // Non-differentiator packs stay available on every tier.
      for (const id of ['plugin_pack', 'api_pack', 'ai_pack', 'storage_pack']) {
        expect(bundles.find((x) => x.id === id)?.availableForTiers).toEqual(
          ['developer', 'pro', 'team', 'enterprise'],
        );
      }
      // `seat` and `pipeline_pack` are the tier differentiators — Team+ only, so a
      // Developer/Pro can't cheaply stack them to undercut Team.
      expect(bundles.find((x) => x.id === 'seat')?.availableForTiers).toEqual(['team', 'enterprise']);
      expect(bundles.find((x) => x.id === 'pipeline_pack')?.availableForTiers).toEqual(['team', 'enterprise']);
    });

    it('sells a stackable Listing Pack (+10 listings, $4.99/mo) on every tier', () => {
      const { bundles } = loadBillingConfig();
      const pack = bundles.find((x) => x.id === 'listing_pack');
      expect(pack).toMatchObject({
        grants: { listings: 10 },
        prices: { monthly: 499, annual: 4990 },
        stackable: true,
        availableForTiers: ['developer', 'pro', 'team', 'enterprise'],
      });
      expect(pack?.features).toBeUndefined();
    });

    it('overrides purchasable tiers from BILLING_BUNDLE_<ID>_TIERS', () => {
      process.env.BILLING_BUNDLE_SEAT_TIERS = '["pro","enterprise"]';
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'seat')?.availableForTiers).toEqual(['pro', 'enterprise']);
    });

    it('ignores a tiers override that is malformed, empty, or names an unknown tier', () => {
      process.env.BILLING_BUNDLE_PLUGIN_PACK_TIERS = 'not-json';
      process.env.BILLING_BUNDLE_API_PACK_TIERS = '[]';
      process.env.BILLING_BUNDLE_SEAT_TIERS = '["pro","bogus"]';
      const { bundles } = loadBillingConfig();
      const all = ['developer', 'pro', 'team', 'enterprise'];
      expect(bundles.find((x) => x.id === 'plugin_pack')?.availableForTiers).toEqual(all);
      expect(bundles.find((x) => x.id === 'api_pack')?.availableForTiers).toEqual(all);
      // seat's malformed override falls back to its Team+ default, not `all`.
      expect(bundles.find((x) => x.id === 'seat')?.availableForTiers).toEqual(['team', 'enterprise']);
    });

    it('defines the Analytics Suite combo (DORA + Team Usage Analytics) at $42/$420 (~30% off)', () => {
      const { comboDiscounts } = loadBillingConfig();
      const suite = comboDiscounts.find((c) => c.id === 'analytics_suite');
      expect(suite).toMatchObject({
        id: 'analytics_suite',
        bundleIds: ['advanced_reporting', 'team_usage_analytics'],
        prices: { monthly: 4200, annual: 42000 },
        isActive: true,
      });
    });

    it('overrides a combo price from the environment', () => {
      process.env.BILLING_COMBO_ANALYTICS_SUITE_MONTHLY = '3500';
      process.env.BILLING_COMBO_ANALYTICS_SUITE_ANNUAL = '35000';
      const { comboDiscounts } = loadBillingConfig();
      expect(comboDiscounts.find((c) => c.id === 'analytics_suite')?.prices).toEqual({ monthly: 3500, annual: 35000 });
    });

    it('defines the Team Growth combo (≥5 Seats + Team Usage Analytics) at $90.99/$909.90 (~30% off)', () => {
      const { comboDiscounts } = loadBillingConfig();
      const tg = comboDiscounts.find((c) => c.id === 'team_growth');
      expect(tg).toMatchObject({
        id: 'team_growth',
        bundleIds: ['seat', 'team_usage_analytics'],
        minQuantities: { seat: 5 },
        prices: { monthly: 9099, annual: 90990 },
        sortOrder: 1,
        isActive: true,
      });
    });

    it('defines the Scale Bundle combo (API Pack + Storage Pack) at $27.99/$279.90 (~30% off)', () => {
      const { comboDiscounts } = loadBillingConfig();
      const sb = comboDiscounts.find((c) => c.id === 'scale_bundle');
      expect(sb).toMatchObject({
        id: 'scale_bundle',
        bundleIds: ['api_pack', 'storage_pack'],
        prices: { monthly: 2799, annual: 27990 },
        sortOrder: 3,
        isActive: true,
      });
    });

    it('defines the compliance content add-ons + Suite combo (Advanced requires Standard)', () => {
      const { bundles, comboDiscounts } = loadBillingConfig();
      // Standard — feature bundle, Dev/Pro/Team, no prerequisite.
      expect(bundles.find((x) => x.id === 'compliance_standard')).toMatchObject({
        id: 'compliance_standard',
        features: ['compliance_standard'],
        grants: {},
        stackable: false,
        availableForTiers: ['developer', 'pro', 'team'],
        prices: { monthly: 2990, annual: 29900 },
      });
      expect(bundles.find((x) => x.id === 'compliance_standard')?.requires).toBeUndefined();
      // Advanced — feature bundle, REQUIRES Standard.
      expect(bundles.find((x) => x.id === 'compliance_advanced')).toMatchObject({
        id: 'compliance_advanced',
        features: ['compliance_advanced'],
        stackable: false,
        availableForTiers: ['developer', 'pro', 'team'],
        prices: { monthly: 9990, annual: 99900 },
        requires: ['compliance_standard'],
      });
      // Suite combo — both at 30% off ($908.60/yr vs $1,298 list).
      expect(comboDiscounts.find((c) => c.id === 'compliance_suite')).toMatchObject({
        id: 'compliance_suite',
        bundleIds: ['compliance_standard', 'compliance_advanced'],
        prices: { monthly: 9086, annual: 90860 },
        isActive: true,
      });
    });

    it('warns when a combo is configured with no actual discount (combined ≥ basket)', () => {
      // Force the Team Growth combined price above its $55 member basket.
      process.env.BILLING_COMBO_TEAM_GROWTH_MONTHLY = '999999';
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      loadBillingConfig();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('team_growth'));
      warn.mockRestore();
    });
  });

  describe('requires validity + cycle assertion', () => {
    it('accepts the real catalog (loadBillingConfig does not throw)', () => {
      expect(() => loadBillingConfig()).not.toThrow();
    });

    it('accepts a valid requires chain', () => {
      const bundles = [
        mkBundle('base'),
        mkBundle('mid', { requires: ['base'] }),
        mkBundle('top', { requires: ['mid'] }),
      ];
      expect(() => assertBundleRequiresValid(bundles)).not.toThrow();
    });

    it('throws when a requires id does not resolve to a bundle (dangling)', () => {
      const bundles = [mkBundle('advanced', { requires: ['nonexistent'] })];
      expect(() => assertBundleRequiresValid(bundles))
        .toThrow(/requires "nonexistent".*not an active bundle/);
    });

    it('throws when a requires id names an inactive bundle', () => {
      const bundles = [
        mkBundle('base', { isActive: false }),
        mkBundle('advanced', { requires: ['base'] }),
      ];
      expect(() => assertBundleRequiresValid(bundles))
        .toThrow(/requires "base".*not an active bundle/);
    });

    it('throws on a direct self-requires cycle', () => {
      const bundles = [mkBundle('loop', { requires: ['loop'] })];
      expect(() => assertBundleRequiresValid(bundles)).toThrow(/cycle detected/);
    });

    it('accepts a feature prerequisite a tier includes or can buy', () => {
      const bundles = [
        // pro buys `advanced_reporting` via the grant bundle; enterprise includes it.
        mkBundle('grant', { features: ['advanced_reporting'], availableForTiers: ['pro'] }),
        mkBundle('dependent', { requiresFeatures: ['advanced_reporting'], availableForTiers: ['pro', 'enterprise'] }),
      ];
      expect(() => assertBundleRequiresValid(bundles)).not.toThrow();
    });

    it('throws when requiresFeatures names an unknown feature flag', () => {
      const bundles = [mkBundle('dependent', { requiresFeatures: ['not_a_flag'] })];
      expect(() => assertBundleRequiresValid(bundles)).toThrow(/requiresFeatures "not_a_flag".*not a feature flag/);
    });

    it('throws when a sold-to tier can neither include nor buy the required feature', () => {
      // developer has no tier features and nothing here grants advanced_reporting.
      const bundles = [mkBundle('dependent', { requiresFeatures: ['advanced_reporting'], availableForTiers: ['developer'] })];
      expect(() => assertBundleRequiresValid(bundles)).toThrow(/developer tier neither includes nor can buy/);
    });

    it('throws when a combo names a bundle that is not in the catalog', () => {
      // This is what withdrawing a bundle would leave behind if a combo still
      // listed it: the member resolves to nothing, the basket is priced as if it
      // were free, and the combo silently grants a credit for a SKU nobody holds.
      const bundles = [mkBundle('api_pack')];
      expect(() => assertCombosValid([mkCombo('gone', ['api_pack', 'sso'])], bundles))
        .toThrow(/references bundle "sso", which is not an active bundle/);
    });

    it('throws when a combo names an INACTIVE bundle', () => {
      const bundles = [mkBundle('api_pack'), mkBundle('retired', { isActive: false })];
      expect(() => assertCombosValid([mkCombo('stale', ['api_pack', 'retired'])], bundles))
        .toThrow(/references bundle "retired", which is not an active bundle/);
    });

    it('throws on a multi-node requires cycle', () => {
      const bundles = [
        mkBundle('a', { requires: ['b'] }),
        mkBundle('b', { requires: ['c'] }),
        mkBundle('c', { requires: ['a'] }),
      ];
      expect(() => assertBundleRequiresValid(bundles)).toThrow(/cycle detected/);
    });
  });
});
