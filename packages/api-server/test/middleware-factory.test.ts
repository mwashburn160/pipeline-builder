// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('@pipeline-builder/api-core', () => ({
  requireAuth: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

jest.mock('../src/api/check-quota', () => ({
  checkQuota: jest.fn(() => 'CHECK_QUOTA_MIDDLEWARE'),
}));

jest.mock('../src/api/require-org-id', () => ({
  requireOrgId: jest.fn(() => 'REQUIRE_ORG_ID_MIDDLEWARE'),
}));

import {
  createProtectedRoute,
  createAuthenticatedWithOrgRoute,
} from '../src/api/middleware-factory';
import { checkQuota } from '../src/api/check-quota';
import { requireOrgId } from '../src/api/require-org-id';

describe('createProtectedRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an array of three middleware', () => {
    const fakeQuotaService = {} as any;
    const result = createProtectedRoute(fakeQuotaService, 'apiCalls' as any);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
  });

  it('invokes requireOrgId() and checkQuota() factories', () => {
    const fakeQuotaService = {} as any;
    createProtectedRoute(fakeQuotaService, 'pipelines' as any);
    expect(requireOrgId).toHaveBeenCalledTimes(1);
    expect(checkQuota).toHaveBeenCalledWith(fakeQuotaService, 'pipelines');
  });

  it('places middleware in order: auth, orgId, quota', () => {
    const fakeQuotaService = {} as any;
    const result = createProtectedRoute(fakeQuotaService, 'plugins' as any);
    expect(result[1]).toBe('REQUIRE_ORG_ID_MIDDLEWARE');
    expect(result[2]).toBe('CHECK_QUOTA_MIDDLEWARE');
  });
});

describe('createAuthenticatedWithOrgRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an array of two middleware', () => {
    const result = createAuthenticatedWithOrgRoute();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('invokes requireOrgId() factory', () => {
    createAuthenticatedWithOrgRoute();
    expect(requireOrgId).toHaveBeenCalledTimes(1);
  });

  it('does not invoke checkQuota', () => {
    createAuthenticatedWithOrgRoute();
    expect(checkQuota).not.toHaveBeenCalled();
  });

  it('places auth middleware first, orgId second', () => {
    const result = createAuthenticatedWithOrgRoute();
    expect(result[1]).toBe('REQUIRE_ORG_ID_MIDDLEWARE');
  });
});
