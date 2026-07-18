// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guards the flat-org fast path in `pooledLimitAndUsage` (via `incrementUsage`).
 *
 * Every org is flat today, and increment is the hottest path in the service.
 * The pooling pre-check must short-circuit on a single-field `parentOrgId` read
 * BEFORE the two-query hierarchy walk (`resolveRootOrgId` + `expandOrgScope`) —
 * so a flat increment never touches `expandOrgScope`. An org that DOES have a
 * parent must still pool: walk the hierarchy and enforce the shared root cap.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isValidTier: () => true,
  ValidationError: class ValidationError extends Error {},
  DEFAULT_TIER: 'developer',
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'],
  QUOTA_TIERS: { developer: { limits: { plugins: 100, pipelines: 10, apiCalls: -1 } } },
  VALID_TIERS: ['developer', 'pro', 'team', 'enterprise'],
  isValidQuotaType: (t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t),
}));

// Spy hierarchy resolvers so we can assert exactly which ones the increment path
// invokes for a flat vs. a child org.
const getParentOrgId = jest.fn<(id: string) => Promise<string | undefined>>();
const resolveRootOrgId = jest.fn<(id: string) => Promise<string>>();
const expandOrgScope = jest.fn<(id: string) => Promise<string[]>>();
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  getParentOrgId,
  resolveRootOrgId,
  expandOrgScope,
}));

const findOneAndUpdate = jest.fn();
const findById = jest.fn();
const find = jest.fn();
jest.unstable_mockModule('../src/models/organization.js', () => ({
  Organization: { findOneAndUpdate, findById, find },
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { quota: { resetDays: 30 } },
}));

const { quotaService } = await import('../src/services/quota-service.js');

const future = new Date(Date.now() + 86_400_000); // resetAt in the future (period live)

// Atomic-increment success doc read back by incrementUsage on the flat path.
const incrementedOrg = {
  quotas: { plugins: 100 },
  usage: { plugins: { used: 1, resetAt: future } },
};

beforeEach(() => {
  jest.clearAllMocks();
  findOneAndUpdate.mockResolvedValue(incrementedOrg);
});

describe('pooledLimitAndUsage flat-org short-circuit', () => {
  it('flat org (no parent): short-circuits before the hierarchy walk — no expandOrgScope', async () => {
    getParentOrgId.mockResolvedValue(undefined); // no parent ⇒ flat

    const result = await quotaService.incrementUsage('org-flat', 'plugins', 1);

    // The single-field parent read happened...
    expect(getParentOrgId).toHaveBeenCalledWith('org-flat');
    // ...but the two-query hierarchy walk was skipped entirely.
    expect(resolveRootOrgId).not.toHaveBeenCalled();
    expect(expandOrgScope).not.toHaveBeenCalled();
    // Increment proceeded down the atomic pipeline-update path.
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(result.exceeded).toBe(false);
  });

  it('child org (has parent): still pools — walks the hierarchy and enforces the shared root cap', async () => {
    getParentOrgId.mockResolvedValue('root'); // has a parent ⇒ pool
    resolveRootOrgId.mockResolvedValue('root');
    expandOrgScope.mockResolvedValue(['root', 'child']);

    // Root limit 100; pooled subtree usage 95 + 10 = 105 already over cap.
    findById.mockReturnValue({
      select: () => ({ lean: async () => ({ quotas: { plugins: 100 }, usage: { plugins: { used: 95, resetAt: future } } }) }),
    });
    find.mockReturnValue({
      select: () => ({
        lean: async () => [
          { usage: { plugins: { used: 95, resetAt: future } } },
          { usage: { plugins: { used: 10, resetAt: future } } },
        ],
      }),
    });

    const result = await quotaService.incrementUsage('child', 'plugins', 1);

    // Pooling engaged: the hierarchy walk ran.
    expect(resolveRootOrgId).toHaveBeenCalledWith('child');
    expect(expandOrgScope).toHaveBeenCalledWith('root');
    // Shared cap breached (105 + 1 > 100) ⇒ exceeded, and the per-org atomic
    // increment is short-circuited (never runs).
    expect(result.exceeded).toBe(true);
    expect(result.quota.limit).toBe(100);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});
