// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /organization/:id/support-usage` (X1) — the read billing's support
 * over-cap gate and entitlement-drift reconciler depend on. Billing rejects a
 * partial payload (and then skips every subscription), so the shape is pinned:
 * both dimensions, both numbers, read at the ACCOUNT ROOT and pooled over its
 * whole subtree.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

let isService = false;
let isAdmin = false;
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ isServicePrincipal: () => isService }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  ensureAuthenticated: (req: { user?: unknown }) => !!req.user,
  canAdministerOrg: async () => isAdmin,
  forbid: (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }) => res.status(403).json({}),
  withController: (_l: string, fn: unknown) => fn,
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({ pooledFeatureEntitlements: jest.fn(), pooledSeatUsage: jest.fn() }));
jest.unstable_mockModule('../src/services/index.js', () => ({ organizationService: {} }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  resolveOrgLineage: async () => ({ rootOrgId: 'root-1' }),
  expandOrgScope: async (id: string) => [id, 'team-a', 'team-b'],
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: string) => v }));
const findById = jest.fn((_id: string) => ({ select: () => ({ lean: async () => ({ quotas: { supportContacts: 5, supportPremiumContacts: -1 } }) }) }));
jest.unstable_mockModule('../src/models/index.js', () => ({ Organization: { findById: (id: string) => findById(id) } }));
const scopes: string[][] = [];
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  countActiveSupportContacts: async (s: string[]) => { scopes.push(s); return 3; },
  countPremiumSupportContacts: async (s: string[]) => { scopes.push(s); return 1; },
  runWithTenantContext: (_c: unknown, fn: () => unknown) => fn(),
}));

const { getOrganizationSupportUsage } = await import('../src/controllers/organization-internal.js');

function call(user: unknown) {
  const res: { statusCode?: number; body?: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
  };
  return (getOrganizationSupportUsage as unknown as (q: unknown, r: unknown) => Promise<void>)(
    { user, params: { id: 'team-a' }, headers: {} }, res,
  ).then(() => res);
}

beforeEach(() => { isService = false; isAdmin = false; scopes.length = 0; findById.mockClear(); });

describe('GET /organization/:id/support-usage', () => {
  it('answers a service principal with both dimensions, read at the root and pooled over the subtree', async () => {
    isService = true;
    const res = await call({ sub: 'billing' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: unknown }).data).toEqual({
      supportContacts: { limit: 5, used: 3 },
      supportPremiumContacts: { limit: -1, used: 1 },
    });
    expect(findById).toHaveBeenCalledWith('root-1');
    expect(scopes).toEqual([['root-1', 'team-a', 'team-b'], ['root-1', 'team-a', 'team-b']]);
  });

  it('answers an admin of the account', async () => {
    isAdmin = true;
    expect((await call({ sub: 'u1' })).statusCode).toBe(200);
  });

  it('refuses anyone else', async () => {
    expect((await call({ sub: 'u2' })).statusCode).toBe(403);
    expect(scopes).toEqual([]);
  });
});
