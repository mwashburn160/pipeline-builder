// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Capture the tenant scope handed to runWithTenantContext so we can assert the
// default `identityScope` resolver reads the CALLER's (already-normalized) org.
const capturedScopes: Array<Record<string, unknown>> = [];
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  runWithTenantContext: (scope: Record<string, unknown>, cb: () => unknown) => {
    capturedScopes.push(scope);
    return cb();
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // isSystemAdmin reads the verified super-admin claim off req.user.
  isSystemAdmin: (req: { user?: { isSuperAdmin?: boolean } }) => req.user?.isSuperAdmin === true,
}));

const { withTenantContext } = await import('../src/api/tenant-context.js');

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    // getContext reads req.context; identity.orgId is normalized upstream.
    context: { identity: { orgId: 'acme' } },
    user: {},
    ...overrides,
  };
}

describe('withTenantContext (identityScope)', () => {
  beforeEach(() => {
    capturedScopes.length = 0;
  });

  it('opens the RLS scope on the caller identity org (normalized) and calls next', () => {
    const req = mockReq({
      context: { identity: { orgId: 'acme' } },
      user: { parentOrganizationId: 'parent-org' },
    });
    const next = jest.fn();
    withTenantContext()(req, {} as any, next);

    expect(capturedScopes).toHaveLength(1);
    expect(capturedScopes[0]).toEqual({
      orgId: 'acme',
      isSuperAdmin: false,
      parentOrgId: 'parent-org',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets isSuperAdmin from the verified super-admin claim', () => {
    const req = mockReq({
      context: { identity: { orgId: 'acme' } },
      user: { isSuperAdmin: true },
    });
    const next = jest.fn();
    withTenantContext()(req, {} as any, next);

    expect(capturedScopes[0].isSuperAdmin).toBe(true);
  });

  it('hard-FAILS the request (500 via next(err)) when the resolver throws', () => {
    const boom = new Error('scope resolution failed');
    const throwingResolver = () => { throw boom; };
    const req = mockReq();
    const next = jest.fn();

    withTenantContext(throwingResolver)(req, {} as any, next);

    // The scope was never opened and the error is forwarded to the error handler.
    expect(capturedScopes).toHaveLength(0);
    expect(next).toHaveBeenCalledWith(boom);
  });
});
