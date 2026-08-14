// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import type { HttpRequest } from '../src/types/http.js';
import { getIdentity } from '../src/utils/identity.js';

// Helpers
function mockRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    headers: {},
    params: {},
    query: {},
    ...overrides,
  };
}

// Tests

describe('getIdentity', () => {
  it('should extract identity from headers', () => {
    const req = mockRequest({
      headers: {
        'x-org-id': 'org-1',
        'x-user-id': 'user-1',
        'x-request-id': 'req-123',
        'x-user-role': 'admin',
      },
    });
    const identity = getIdentity(req);
    expect(identity.orgId).toBe('org-1');
    expect(identity.userId).toBe('user-1');
    expect(identity.requestId).toBe('req-123');
    expect(identity.role).toBe('admin');
  });

  it('should prefer JWT claims (req.user) over headers', () => {
    // The JWT payload uses `sub` (OIDC) for the user id; the verified-
    // claims path through getIdentity reads from there. Headers are only
    // consulted when the JWT field is absent.
    const req = mockRequest({
      headers: {
        'x-org-id': 'header-org',
        'x-user-id': 'header-user',
        'x-user-role': 'user',
      },
      user: {
        sub: 'jwt-user',
        organizationId: 'jwt-org',
        role: 'admin',
      },
    });
    const identity = getIdentity(req);
    expect(identity.orgId).toBe('jwt-org');
    expect(identity.userId).toBe('jwt-user');
    expect(identity.role).toBe('admin');
  });

  it('should fall back to headers when user fields are missing', () => {
    const req = mockRequest({
      headers: {
        'x-org-id': 'header-org',
        'x-user-id': 'header-user',
      },
      user: {},
    });
    const identity = getIdentity(req);
    expect(identity.orgId).toBe('header-org');
    expect(identity.userId).toBe('header-user');
  });

  it('should return requestId only from header (not in JWT)', () => {
    const req = mockRequest({
      headers: { 'x-request-id': 'trace-456' },
      user: { organizationId: 'org-1' },
    });
    const identity = getIdentity(req);
    expect(identity.requestId).toBe('trace-456');
  });

  it('normalizes orgId to trimmed lowercase (single source of truth for RLS)', () => {
    // Mixed-case + surrounding whitespace from a JWT claim must be canonicalized
    // ONCE here so the RLS GUC and the app-layer WHERE clause always agree.
    const req = mockRequest({ user: { organizationId: '  ACME-Org  ' } });
    expect(getIdentity(req).orgId).toBe('acme-org');
  });

  it('normalizes a header-sourced orgId too', () => {
    const req = mockRequest({ headers: { 'x-org-id': 'Header-ORG' } });
    expect(getIdentity(req).orgId).toBe('header-org');
  });

  it('collapses an empty/whitespace-only orgId to undefined', () => {
    const req = mockRequest({ user: { organizationId: '   ' } });
    expect(getIdentity(req).orgId).toBeUndefined();
  });

  it('should return undefined for missing fields', () => {
    const req = mockRequest();
    const identity = getIdentity(req);
    expect(identity.orgId).toBeUndefined();
    expect(identity.userId).toBeUndefined();
    expect(identity.requestId).toBeUndefined();
    expect(identity.role).toBeUndefined();
  });
});
