// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { VALID_TIERS } from '@pipeline-builder/api-core';
import { loadBillingConfig } from '../src/config/billing-config.js';

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

  it('returns four plans with correct defaults', () => {
    const config = loadBillingConfig();
    expect(config.plans).toHaveLength(4);

    const [developer, pro, team, enterprise] = config.plans;

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
      prices: { monthly: 1900, annual: 19000 },
      isDefault: false,
      sortOrder: 1,
    });

    expect(team).toMatchObject({
      id: 'team',
      name: 'Team',
      tier: 'team',
      prices: { monthly: 4900, annual: 49000 },
      isDefault: false,
      sortOrder: 2,
    });

    expect(enterprise).toMatchObject({
      id: 'enterprise',
      name: 'Enterprise',
      tier: 'enterprise',
      prices: { monthly: 9900, annual: 99000 },
      isDefault: false,
      sortOrder: 3,
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
    expect(team.features).toContain('Audit Log');
    expect(enterprise.features).toContain('Custom Integrations');
    // Pro now advertises its enforced Priority Support entitlement (was wrongly
    // marketed as 'Community support' while TIER_FEATURES.pro grants priority_support).
    expect(pro.features).toContain('Priority Support');
    expect(pro.features).not.toContain('Community support');
    // SSO is INCLUDED in Team (TIER_FEATURES.team grants `sso`), so Team markets it
    // (derived from FEATURE_METADATA.sso.label). The Pro tier does NOT — SSO is a
    // Pro-only add-on bundle there.
    expect(team.features).toContain('SSO / IdP');
    expect(pro.features).not.toContain('SSO / IdP');
  });

  it('derives seat lines from tier limits', () => {
    const config = loadBillingConfig();
    const [developer, , team, enterprise] = config.plans;

    expect(developer.features).toContain('Up to 1 seat');
    expect(team.features).toContain('Up to 10 seats');
    expect(enterprise.features).toContain('Up to 25 seats');
  });

  describe('add-on bundles', () => {
    it('returns the default catalog with default prices + grants', () => {
      const { bundles } = loadBillingConfig();
      const seatPack = bundles.find((x) => x.id === 'seat_pack');
      expect(seatPack).toMatchObject({
        id: 'seat_pack',
        grants: { seats: 5 },
        prices: { monthly: 2500, annual: 25000 },
        stackable: true,
      });
      // Feature bundles carry a flag and no numeric grant.
      const sso = bundles.find((x) => x.id === 'sso');
      expect(sso?.features).toContain('sso');
      expect(sso?.stackable).toBe(false);
    });

    it('overrides a bundle price from the environment', () => {
      process.env.BILLING_BUNDLE_SEAT_PACK_MONTHLY = '3000';
      process.env.BILLING_BUNDLE_SEAT_PACK_ANNUAL = '30000';
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'seat_pack')?.prices).toEqual({ monthly: 3000, annual: 30000 });
    });

    it('overrides a single-dimension grant amount from the environment', () => {
      process.env.BILLING_BUNDLE_SEAT_PACK_GRANT = '10';
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'seat_pack')?.grants).toEqual({ seats: 10 });
    });

    it('ignores a malformed or negative grant override', () => {
      process.env.BILLING_BUNDLE_PIPELINE_PACK_GRANT = 'abc';
      process.env.BILLING_BUNDLE_PLUGIN_PACK_GRANT = '-5';
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'pipeline_pack')?.grants).toEqual({ pipelines: 10 });
      expect(bundles.find((x) => x.id === 'plugin_pack')?.grants).toEqual({ plugins: 100 });
    });

    it('ignores a grant override on a feature-only (empty-grant) bundle', () => {
      process.env.BILLING_BUNDLE_AUDIT_LOG_GRANT = '99';
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'audit_log')?.grants).toEqual({});
    });

    it('makes capacity packs (seats/pipelines/plugins) available on every tier by default', () => {
      const { bundles } = loadBillingConfig();
      for (const id of ['seat_pack', 'pipeline_pack', 'plugin_pack']) {
        expect(bundles.find((x) => x.id === id)?.availableForTiers).toEqual(
          ['developer', 'pro', 'team', 'enterprise'],
        );
      }
    });

    it('overrides purchasable tiers from BILLING_BUNDLE_<ID>_TIERS', () => {
      process.env.BILLING_BUNDLE_SEAT_PACK_TIERS = '["pro","enterprise"]';
      const { bundles } = loadBillingConfig();
      expect(bundles.find((x) => x.id === 'seat_pack')?.availableForTiers).toEqual(['pro', 'enterprise']);
    });

    it('ignores a tiers override that is malformed, empty, or names an unknown tier', () => {
      process.env.BILLING_BUNDLE_PIPELINE_PACK_TIERS = 'not-json';
      process.env.BILLING_BUNDLE_PLUGIN_PACK_TIERS = '[]';
      process.env.BILLING_BUNDLE_SEAT_PACK_TIERS = '["pro","bogus"]';
      const { bundles } = loadBillingConfig();
      const all = ['developer', 'pro', 'team', 'enterprise'];
      expect(bundles.find((x) => x.id === 'pipeline_pack')?.availableForTiers).toEqual(all);
      expect(bundles.find((x) => x.id === 'plugin_pack')?.availableForTiers).toEqual(all);
      expect(bundles.find((x) => x.id === 'seat_pack')?.availableForTiers).toEqual(all);
    });
  });
});
