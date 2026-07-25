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

  it('returns an array of five middleware (auth, orgId, idempotency, tenantContext, quota)', () => {
    const fakeQuotaService = {} as any;
    const result = createProtectedRoute(fakeQuotaService, 'apiCalls' as any);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(5);
  });

  it('invokes requireOrgId(), withTenantContext() and checkQuota() factories', () => {
    const fakeQuotaService = {} as any;
    createProtectedRoute(fakeQuotaService, 'pipelines' as any);
    expect(requireOrgId).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(checkQuota).toHaveBeenCalledWith(fakeQuotaService, 'pipelines');
  });

  it('places middleware in order: auth, orgId, idempotency, tenantContext, quota', () => {
    const fakeQuotaService = {} as any;
    const result = createProtectedRoute(fakeQuotaService, 'plugins' as any);
    expect(result[1]).toBe('REQUIRE_ORG_ID_MIDDLEWARE');
    // [2] is the idempotency middleware (a real closure, not a labeled mock) —
    // mounted post-orgId so the verified org can namespace its replay cache.
    expect(typeof result[2]).toBe('function');
    expect(result[3]).toBe('TENANT_CONTEXT_MIDDLEWARE');
    expect(result[4]).toBe('CHECK_QUOTA_MIDDLEWARE');
  });
});

describe('createAuthenticatedWithOrgRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an array of four middleware (auth, orgId, idempotency, tenantContext)', () => {
    const result = createAuthenticatedWithOrgRoute();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(4);
  });

  it('invokes requireOrgId() factory', () => {
    createAuthenticatedWithOrgRoute();
    expect(requireOrgId).toHaveBeenCalledTimes(1);
  });

  it('does not invoke checkQuota', () => {
    createAuthenticatedWithOrgRoute();
    expect(checkQuota).not.toHaveBeenCalled();
  });

  it('places auth first, orgId second, idempotency third, tenantContext fourth', () => {
    const result = createAuthenticatedWithOrgRoute();
    expect(result[1]).toBe('REQUIRE_ORG_ID_MIDDLEWARE');
    expect(typeof result[2]).toBe('function'); // idempotency middleware (real closure)
    expect(result[3]).toBe('TENANT_CONTEXT_MIDDLEWARE');
  });
});
