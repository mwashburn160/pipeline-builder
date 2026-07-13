// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for organizationService.checkTierOvercap (docs/org-team-hierarchy
 * §8 / billing-bundles §8): whether a sysadmin/billing tier DOWNGRADE would drop
 * a pooled COUNT quota below current usage. Guards seats (pooled, via
 * pooledSeatUsage) and plugins/pipelines (summed across the org subtree). An
 * `-1` (unlimited) target cap is never an overage. org-hierarchy + seats helpers
 * are mocked so usage is driven directly.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const limits = (seats: number, plugins: number, pipelines: number, dashboards = -1) => ({
  seats,
  plugins,
  pipelines,
  apiCalls: -1,
  aiCalls: -1,
  storageBytes: -1,
  dashboards,
  alertRules: -1,
  alertDestinations: -1,
  idpConfigs: -1,
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  decryptSecret: jest.fn(),
  encryptSecret: jest.fn(),
  isEncryptedBlob: jest.fn(() => false),
  QUOTA_TIERS: {
    developer: { label: 'Developer', limits: limits(1, 10, 5, 5) },
    pro: { label: 'Pro', limits: limits(3, 100, 50) },
    team: { label: 'Team', limits: limits(10, 500, 200) },
    enterprise: { label: 'Enterprise', limits: limits(-1, -1, -1) },
  },
}));

jest.unstable_mockModule('mongoose', () => {
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    method() { /* no-op */ }
    pre() { /* no-op */ }
    post() { /* no-op */ }
    virtual() { return this; }
    set() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId: class {} };
  }
  return { default: { startSession: jest.fn() }, Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn() };
});

// Authoritative usage read. Default (unset) → resolves undefined, so checkTierOvercap
// falls back to the org-doc sum (mockOrgFind) — the pre-existing behavior the bulk
// of these tests assert. Set a resolved value to drive the authoritative path.
const mockGetQuotaStatus = jest.fn<(...a: unknown[]) => Promise<{ used: number } | null | undefined>>();
jest.unstable_mockModule('../src/middleware/quota.js', () => ({
  getOrganizationQuotaStatus: mockGetQuotaStatus,
  updateQuotaLimits: jest.fn(),
  QuotaType: {},
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { quota: { tier: {} } },
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));

// org-hierarchy + seats mocked so the pooled inputs are fully controlled.
const mockResolveOrgLineage = jest.fn<(...a: unknown[]) => Promise<{ rootOrgId: string }>>();
const mockExpandOrgScope = jest.fn<(...a: unknown[]) => Promise<string[]>>();
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  resolveOrgLineage: mockResolveOrgLineage,
  expandOrgScope: mockExpandOrgScope,
}));

const mockPooledSeatUsage = jest.fn<(...a: unknown[]) => Promise<{ limit: number; used: number }>>();
jest.unstable_mockModule('../src/helpers/seats.js', () => ({
  pooledSeatUsage: mockPooledSeatUsage,
}));

const mockOrgFind = jest.fn<(...a: unknown[]) => any>();
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { find: (...a: unknown[]) => mockOrgFind(...a), findById: jest.fn(), countDocuments: jest.fn() },
  User: { updateOne: jest.fn() },
  UserOrganization: { countDocuments: jest.fn(), create: jest.fn(), distinct: () => ({ session: () => Promise.resolve([]) }) },
  Invitation: { distinct: () => ({ session: () => Promise.resolve([]) }) },
  OrgIdpConfig: { find: jest.fn(), exists: jest.fn() },
  Role: { create: jest.fn(), find: jest.fn(), findOne: jest.fn(), exists: jest.fn() },
  RoleAssignment: { create: jest.fn(), find: jest.fn(), exists: jest.fn(), countDocuments: jest.fn() },
}));

const { organizationService } = await import('../src/services/organization-service.js');

/** Wire the pooled-usage inputs for one call. `rows` feed the plugins/pipelines sum. */
function wire(seatUsed: number, rows: Array<Record<string, number>>) {
  mockResolveOrgLineage.mockResolvedValue({ rootOrgId: 'root-1' });
  mockExpandOrgScope.mockResolvedValue(['root-1', 'team-1']);
  mockPooledSeatUsage.mockResolvedValue({ limit: 0, used: seatUsed });
  // Map every count field present on a row to a { used } usage entry.
  const docs = rows.map((r) => ({ usage: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { used: v }])) }));
  mockOrgFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(docs) }) });
}

beforeEach(() => jest.clearAllMocks());

describe('organizationService.checkTierOvercap', () => {
  it('returns no overages when pooled usage fits the target tier', async () => {
    wire(5, [{ plugins: 30, pipelines: 10 }, { plugins: 10, pipelines: 5 }]); // 40/15 vs team 500/200
    const overages = await organizationService.checkTierOvercap('root-1', 'team');
    expect(overages).toEqual([]);
  });

  it('flags a pooled seat overage on downgrade to pro (cap 3)', async () => {
    wire(8, [{ plugins: 1, pipelines: 1 }]);
    const overages = await organizationService.checkTierOvercap('root-1', 'pro');
    expect(overages).toContainEqual({ quotaType: 'seats', currentUsage: 8, targetCap: 3, overage: 5 });
  });

  it('sums plugins + pipelines across the subtree and flags both on downgrade to developer', async () => {
    // developer caps: seats 1 / plugins 10 / pipelines 5. Seat usage at cap (no trip).
    wire(1, [{ plugins: 7, pipelines: 4 }, { plugins: 5, pipelines: 3 }]); // 12 plugins, 7 pipelines
    const overages = await organizationService.checkTierOvercap('root-1', 'developer');
    expect(overages).toEqual(expect.arrayContaining([
      { quotaType: 'plugins', currentUsage: 12, targetCap: 10, overage: 2 },
      { quotaType: 'pipelines', currentUsage: 7, targetCap: 5, overage: 2 },
    ]));
    expect(overages.find((o) => o.quotaType === 'seats')).toBeUndefined();
  });

  it('never flags an unlimited (-1) target cap even with heavy usage', async () => {
    wire(999, [{ plugins: 9999, pipelines: 9999 }]);
    const overages = await organizationService.checkTierOvercap('root-1', 'enterprise');
    // enterprise allows teams and every count/seat cap is -1 → no overages at all.
    expect(overages).toEqual([]);
    expect(mockPooledSeatUsage).not.toHaveBeenCalled();
  });

  it('flags team-stranding when downgrading a root WITH teams to a team-forbidding tier', async () => {
    // subtree = [root-1, team-1] (from wire). developer/pro forbid teams
    // (checkParentEligible), so the downgrade would strand team-1.
    wire(1, [{ plugins: 1, pipelines: 1 }]);
    const overages = await organizationService.checkTierOvercap('root-1', 'developer');
    expect(overages).toContainEqual({ quotaType: 'teams', currentUsage: 1, targetCap: 0, overage: 1 });
  });

  it('does NOT flag team-stranding when the target tier still allows teams', async () => {
    wire(1, [{ plugins: 1, pipelines: 1 }]);
    const overages = await organizationService.checkTierOvercap('root-1', 'team');
    expect(overages.find((o) => o.quotaType === 'teams')).toBeUndefined();
  });

  it('does NOT flag team-stranding when the root has no teams', async () => {
    wire(1, [{ plugins: 1, pipelines: 1 }]);
    mockExpandOrgScope.mockResolvedValue(['root-1']); // flat root, no teams
    const overages = await organizationService.checkTierOvercap('root-1', 'developer');
    expect(overages.find((o) => o.quotaType === 'teams')).toBeUndefined();
  });

  it('flags an extra count quota (dashboards) over the target cap', async () => {
    // developer dashboards cap is finite in the mock; usage pools across subtree.
    wire(1, [{ dashboards: 12 } as Record<string, number>]);
    const overages = await organizationService.checkTierOvercap('root-1', 'developer');
    expect(overages).toContainEqual({ quotaType: 'dashboards', currentUsage: 12, targetCap: 5, overage: 7 });
  });

  it('uses the quota-service pooled usage (authoritative) and does NOT read org docs', async () => {
    // Quota service reports pooled plugins=14 for the root — over developer cap 10.
    // The per-field call order is [plugins, pipelines, dashboards, alertRules,
    // alertDestinations, idpConfigs]; return a hit for plugins, benign for the rest.
    wire(1, [{ plugins: 1, pipelines: 1 }]); // org-doc fallback would say 1/1 (not over)
    mockGetQuotaStatus.mockImplementation(async (_org, field: string) =>
      field === 'plugins' ? { used: 14 } : { used: 0 });
    const overages = await organizationService.checkTierOvercap('root-1', 'developer');
    expect(overages).toContainEqual({ quotaType: 'plugins', currentUsage: 14, targetCap: 10, overage: 4 });
    // Authoritative read succeeded for every field → the org-doc fallback is never hit.
    expect(mockOrgFind).not.toHaveBeenCalled();
  });

  it('degrades to org-doc usage when the quota service is unavailable for a field', async () => {
    // plugins read fails (null) → fall back to the org-doc sum (12, over cap 10);
    // other fields succeed with benign zero.
    wire(1, [{ plugins: 7, pipelines: 1 }, { plugins: 5, pipelines: 1 }]); // org-doc plugins = 12
    mockGetQuotaStatus.mockImplementation(async (_org, field: string) =>
      field === 'plugins' ? null : { used: 0 });
    const overages = await organizationService.checkTierOvercap('root-1', 'developer');
    expect(overages).toContainEqual({ quotaType: 'plugins', currentUsage: 12, targetCap: 10, overage: 2 });
    expect(mockOrgFind).toHaveBeenCalled();
  });
});
