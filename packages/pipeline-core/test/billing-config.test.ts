import { loadBillingConfig } from '../src/config/billing-config';

describe('loadBillingConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns three plans with correct defaults', () => {
    const config = loadBillingConfig();
    expect(config.plans).toHaveLength(3);

    const [developer, pro, unlimited] = config.plans;

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
      prices: { monthly: 799, annual: 7990 },
      isDefault: false,
      sortOrder: 1,
    });

    expect(unlimited).toMatchObject({
      id: 'unlimited',
      name: 'Unlimited',
      tier: 'unlimited',
      prices: { monthly: 1199, annual: 11990 },
      isDefault: false,
      sortOrder: 2,
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
    process.env.BILLING_PLAN_UNLIMITED_FEATURES = '["Feature A","Feature B"]';

    const config = loadBillingConfig();
    const unlimited = config.plans.find((p) => p.id === 'unlimited');

    expect(unlimited?.features).toEqual(['Feature A', 'Feature B']);
  });

  it('falls back to default features on invalid JSON', () => {
    process.env.BILLING_PLAN_DEVELOPER_FEATURES = 'not-valid-json';

    const config = loadBillingConfig();
    const developer = config.plans.find((p) => p.id === 'developer');

    expect(developer?.features).toContain('Up to 100 plugins');
  });

  it('falls back to default features when JSON is not an array', () => {
    process.env.BILLING_PLAN_PRO_FEATURES = '{"key": "value"}';

    const config = loadBillingConfig();
    const pro = config.plans.find((p) => p.id === 'pro');

    expect(pro?.features).toContain('Up to 1,000 plugins');
  });

  it('includes default features for each plan', () => {
    const config = loadBillingConfig();
    const [developer, pro, unlimited] = config.plans;

    expect(developer.features).toContain('Community support');
    expect(pro.features).toContain('Priority support');
    expect(unlimited.features).toContain('Custom integrations');
  });
});
