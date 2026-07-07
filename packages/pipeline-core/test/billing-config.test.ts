// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { loadBillingConfig } from '../src/config/billing-config.js';

describe('loadBillingConfig', () => {
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

    expect(developer?.features).toContain('Up to 50 plugins');
  });

  it('falls back to default features when JSON is not an array', () => {
    process.env.BILLING_PLAN_PRO_FEATURES = '{"key": "value"}';

    const config = loadBillingConfig();
    const pro = config.plans.find((p) => p.id === 'pro');

    expect(pro?.features).toContain('Up to 500 plugins');
  });

  it('includes default features for each plan', () => {
    const config = loadBillingConfig();
    const [developer, pro, team, enterprise] = config.plans;

    expect(developer.features).toContain('Community support');
    expect(pro.features).toContain('Reporting dashboard');
    expect(team.features).toContain('Audit log');
    expect(enterprise.features).toContain('Custom integrations');
  });

  it('derives seat lines from tier limits', () => {
    const config = loadBillingConfig();
    const [developer, , team, enterprise] = config.plans;

    expect(developer.features).toContain('Up to 1 seat');
    expect(team.features).toContain('Up to 10 seats');
    expect(enterprise.features).toContain('Unlimited seats');
  });
});
