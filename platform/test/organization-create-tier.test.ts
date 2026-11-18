// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /organization — the plan tier a self-serve create may seed.
 *
 * Regression: `createOrganizationSchema.tier` accepts any STANDARD tier and
 * `create()` seeds that tier's quotas straight onto a new root org, while the
 * route needs only `org_settings:write` (which every user holds in their own
 * personal org). With billing on, `{ tier: 'enterprise' }` therefore minted an
 * enterprise org with no subscription behind it.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
let billingEnabled = true;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isBillingEnabled: () => billingEnabled,
  sendError: (res: any, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ expandOrgScope: jest.fn(), isAncestorOrg: jest.fn(async () => false) }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({ pooledSeatUsage: jest.fn(), pooledFeatureEntitlements: jest.fn() }));
jest.unstable_mockModule('../src/services/index.js', () => ({
  organizationService: { create: (...a: unknown[]) => mockCreate(...a) },
  orgHierarchyService: {},
  changedAiProviderFields: () => [],
}));
jest.unstable_mockModule('../src/services/org-cascade-service.js', () => ({ softDeleteOrg: jest.fn(), exportOrg: jest.fn() }));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_schema: unknown, body: unknown) => body,
  createOrganizationSchema: {},
  updateOrganizationSchema: {},
  updateOrgIdentitySchema: {},
}));

const { createOrganization } = await import('../src/controllers/organization.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const call = async (user: Record<string, unknown>, body: Record<string, unknown>) => {
  const res = makeRes();
  await (createOrganization as any)({ user: { sub: 'u1', ...user }, headers: {}, body }, res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  billingEnabled = true;
  mockCreate.mockResolvedValue({ id: 'o1', name: 'Acme', slug: 'acme', description: '', tier: 'developer' });
});

describe('createOrganization — tier selection', () => {
  it('REFUSES a non-default tier for a self-serve root org while billing is on (403, nothing created)', async () => {
    const res = await call({ permissions: ['org_settings:write'] }, { name: 'Acme', tier: 'enterprise' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates on the default tier', async () => {
    const res = await call({ permissions: ['org_settings:write'] }, { name: 'Acme', tier: 'developer' });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('lets a platform operator (orgs:manage) seed another tier', async () => {
    const res = await call({ isSuperAdmin: true }, { name: 'Acme', tier: 'enterprise' });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('allows any standard tier when billing is off (nothing is sold)', async () => {
    billingEnabled = false;
    const res = await call({ permissions: ['org_settings:write'] }, { name: 'Acme', tier: 'enterprise' });
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
