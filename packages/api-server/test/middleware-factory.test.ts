// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  requireAuth: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

jest.unstable_mockModule('../src/api/check-quota.js', () => ({
  checkQuota: jest.fn(() => 'CHECK_QUOTA_MIDDLEWARE'),
}));

jest.unstable_mockModule('../src/api/require-org-id.js', () => ({
  requireOrgId: jest.fn(() => 'REQUIRE_ORG_ID_MIDDLEWARE'),
}));

jest.unstable_mockModule('../src/api/tenant-context.js', () => ({
  withTenantContext: jest.fn(() => 'TENANT_CONTEXT_MIDDLEWARE'),
}));

const { checkQuota } = await import('../src/api/check-quota.js');
const {
  createProtectedRoute,
  createAuthenticatedWithOrgRoute,
} = await import('../src/api/middleware-factory.js');
const { requireOrgId } = await import('../src/api/require-org-id.js');
const { withTenantContext } = await import('../src/api/tenant-context.js');

describe('createProtectedRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an array of four middleware', () => {
    const fakeQuotaService = {} as any;
    const result = createProtectedRoute(fakeQuotaService, 'apiCalls' as any);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(4);
  });

  it('invokes requireOrgId(), withTenantContext() and checkQuota() factories', () => {
    const fakeQuotaService = {} as any;
    createProtectedRoute(fakeQuotaService, 'pipelines' as any);
    expect(requireOrgId).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(checkQuota).toHaveBeenCalledWith(fakeQuotaService, 'pipelines');
  });

  it('places middleware in order: auth, orgId, tenantContext, quota', () => {
    const fakeQuotaService = {} as any;
    const result = createProtectedRoute(fakeQuotaService, 'plugins' as any);
    expect(result[1]).toBe('REQUIRE_ORG_ID_MIDDLEWARE');
    expect(result[2]).toBe('TENANT_CONTEXT_MIDDLEWARE');
    expect(result[3]).toBe('CHECK_QUOTA_MIDDLEWARE');
  });
});

describe('createAuthenticatedWithOrgRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an array of three middleware', () => {
    const result = createAuthenticatedWithOrgRoute();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
  });

  it('invokes requireOrgId() factory', () => {
    createAuthenticatedWithOrgRoute();
    expect(requireOrgId).toHaveBeenCalledTimes(1);
  });

  it('does not invoke checkQuota', () => {
    createAuthenticatedWithOrgRoute();
    expect(checkQuota).not.toHaveBeenCalled();
  });

  it('places auth middleware first, orgId second, tenantContext third', () => {
    const result = createAuthenticatedWithOrgRoute();
    expect(result[1]).toBe('REQUIRE_ORG_ID_MIDDLEWARE');
    expect(result[2]).toBe('TENANT_CONTEXT_MIDDLEWARE');
  });
});
