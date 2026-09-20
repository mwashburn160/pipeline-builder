// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import type { HttpRequest } from '../src/types/http.js';
import { actorId, getIdentity, normalizeOrgId, SYSTEM_ACTOR_ID } from '../src/utils/identity.js';

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

  it('falls back to headers for non-tenant fields when user fields are missing', () => {
    const req = mockRequest({
      headers: {
        'x-org-id': 'header-org',
        'x-user-id': 'header-user',
      },
      user: {},
    });
    const identity = getIdentity(req);
    expect(identity.userId).toBe('header-user');
    // `x-org-id` is NOT honored: a principal is attached, so the JWT is the only
    // tenant authority (an unrecognized principalType fails closed).
    expect(identity.orgId).toBeUndefined();
  });

  // ---- x-org-id trust boundary ----

  it('IGNORES x-org-id for a USER principal with no organizationId', () => {
    // Platform can mint a user token with no org (a person between orgs, mid
    // invite/onboarding). Honoring the client-settable header there let such a
    // token name ANY tenant — a value that flows straight into the RLS GUC.
    const req = mockRequest({
      headers: { 'x-org-id': 'victim-org' },
      user: { sub: 'user-1', principalType: 'user' },
    });
    expect(getIdentity(req).orgId).toBeUndefined();
  });

  it('IGNORES x-org-id for a SERVICE ACCOUNT principal with no organizationId', () => {
    const req = mockRequest({
      headers: { 'x-org-id': 'victim-org' },
      user: { sub: 'sa-1', principalType: 'service_account' },
    });
    expect(getIdentity(req).orgId).toBeUndefined();
  });

  it('never lets x-org-id override a USER principal\'s own org', () => {
    const req = mockRequest({
      headers: { 'x-org-id': 'victim-org' },
      user: { sub: 'user-1', principalType: 'user', organizationId: 'own-org' },
    });
    expect(getIdentity(req).orgId).toBe('own-org');
  });

  it('HONORS x-org-id for an internal SERVICE principal (the S2S hop convention)', () => {
    // A service token names the signing SERVICE, not the tenant it is acting
    // for — the acting tenant travels in the header.
    const req = mockRequest({
      headers: { 'x-org-id': 'Acting-ORG' },
      user: { sub: 'service:plugin', principalType: 'service' },
    });
    expect(getIdentity(req).orgId).toBe('acting-org');
  });

  it('still reads x-org-id pre-auth (no principal attached yet)', () => {
    // `attachRequestContext` runs before `requireAuth`, which recomputes this.
    const req = mockRequest({ headers: { 'x-org-id': 'header-org' } });
    expect(getIdentity(req).orgId).toBe('header-org');
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

  it('normalizeOrgId is the shared spelling rule every hop uses', () => {
    // Platform's `controller-helper` and quota's `authorizeOrg` compare through
    // this same function, so a mixed-case org id is judged identically at each.
    expect(normalizeOrgId('  ABCDEF012345678901234567  ')).toBe('abcdef012345678901234567');
    expect(normalizeOrgId('abcdef012345678901234567')).toBe('abcdef012345678901234567');
    expect(normalizeOrgId('  ')).toBeUndefined();
    expect(normalizeOrgId(undefined)).toBeUndefined();
    expect(normalizeOrgId(null)).toBeUndefined();
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

describe('actorId', () => {
  it('uses the route context userId when the request is attributable', () => {
    expect(actorId({ userId: 'user-1' })).toBe('user-1');
  });

  it('falls back to the one system sentinel when nothing attributes the write', () => {
    // The three hand-rolled spellings this replaced ('', 'system', and
    // `req.user?.sub ?? userId ?? "system"`) all collapse to this.
    expect(actorId({ userId: '' })).toBe(SYSTEM_ACTOR_ID);
    expect(actorId({ userId: undefined })).toBe(SYSTEM_ACTOR_ID);
    expect(actorId({ userId: null })).toBe(SYSTEM_ACTOR_ID);
    expect(actorId({})).toBe(SYSTEM_ACTOR_ID);
    expect(SYSTEM_ACTOR_ID).toBe('system');
  });

  it('accepts a whole route context, which carries the resolved identity', () => {
    // `withRoute` sets `userId` from `getIdentity`, so the value the audit
    // trail records is the same one the request is scoped by.
    const identity = getIdentity(mockRequest({ user: { sub: 'user-42' } }));
    expect(actorId({ userId: identity.userId, orgId: identity.orgId } as { userId?: string })).toBe('user-42');
  });
});
