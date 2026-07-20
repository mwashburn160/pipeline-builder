// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeAll } from '@jest/globals';

import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
  requireAuth, requireAdmin, isSystemAdmin, resolveAccessModifier,
  signServiceToken, getServiceAuthHeader, isServicePrincipal, verifyServicePrincipal,
  requirePermission, requireSystemAdmin, setAuthzDenialAuditor,
  requireAllPermissions, setTokenRevocationStore,
} from '../src/middleware/auth.js';
import type { AuthzDenialInfo } from '../src/middleware/auth.js';
import type { JwtPayload } from '../src/types/common.js';

const TEST_SECRET = 'test-jwt-secret-for-unit-tests';

// Set JWT_SECRET before importing auth (lazy-loaded)
beforeAll(() => {
  process.env.JWT_SECRET = TEST_SECRET;
});

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    user: undefined,
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 0,
    _json: null as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

function signToken(payload: Record<string, unknown>, options?: jwt.SignOptions): string {
  return jwt.sign(payload, TEST_SECRET, options);
}

// requireAuth

describe('requireAuth', () => {
  it('should reject request with no Authorization header', () => {
    const req = createMockReq();
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject malformed Authorization header', () => {
    const req = createMockReq({ headers: { authorization: 'Basic abc123' } });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject expired token', () => {
    const token = signToken({ type: 'access', sub: 'user1' }, { expiresIn: '0s' });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = createMockRes();
    const next = jest.fn();

    // Small delay to ensure token expires
    requireAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject invalid token', () => {
    const req = createMockReq({ headers: { authorization: 'Bearer invalid.token.here' } });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject non-access token type', () => {
    const token = signToken({ type: 'refresh', sub: 'user1' });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should accept valid access token and attach user', () => {
    const payload = { type: 'access', sub: 'user1', role: 'member', organizationId: 'org1' };
    const token = signToken(payload);
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(req.user!.sub).toBe('user1');
    expect(req.user!.organizationId).toBe('org1');
  });

  it('should IGNORE org header override for a non-sysadmin even when enabled', () => {
    // The override is sysadmin-only — a normal user cannot impersonate another
    // tenant's org via x-org-id, regardless of the route enabling the option.
    const payload = { type: 'access', sub: 'user1', role: 'member', organizationId: 'org1' };
    const token = signToken(payload);
    const req = createMockReq({
      headers: {
        'authorization': `Bearer ${token}`,
        'x-org-id': 'override-org',
      },
    });
    const res = createMockRes();
    const next = jest.fn();

    const middleware = requireAuth({ allowOrgHeaderOverride: true });
    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user!.organizationId).toBe('org1');
  });

  it('should apply org header override for a sysadmin when enabled', () => {
    const payload = { type: 'access', sub: 'admin1', role: 'owner', organizationId: 'org1', isSuperAdmin: true };
    const token = signToken(payload);
    const req = createMockReq({
      headers: {
        'authorization': `Bearer ${token}`,
        'x-org-id': 'override-org',
      },
    });
    const res = createMockRes();
    const next = jest.fn();

    const middleware = requireAuth({ allowOrgHeaderOverride: true });
    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user!.organizationId).toBe('override-org');
  });

  it('should NOT apply org header override when not enabled', () => {
    const payload = { type: 'access', sub: 'user1', role: 'member', organizationId: 'org1' };
    const token = signToken(payload);
    const req = createMockReq({
      headers: {
        'authorization': `Bearer ${token}`,
        'x-org-id': 'override-org',
      },
    });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user!.organizationId).toBe('org1');
  });
});

// requireAdmin

describe('requireAdmin', () => {
  it('should reject when no user', () => {
    const req = createMockReq();
    const res = createMockRes();
    const next = jest.fn();

    requireAdmin(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject non-admin users', () => {
    const req = createMockReq();
    req.user = { sub: 'user1', role: 'member' } as any;
    const res = createMockRes();
    const next = jest.fn();

    requireAdmin(req, res, next);

    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should allow admin users', () => {
    const req = createMockReq();
    req.user = { sub: 'user1', role: 'admin' } as any;
    const res = createMockRes();
    const next = jest.fn();

    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('should allow owner users', () => {
    const req = createMockReq();
    req.user = { sub: 'user1', role: 'owner' } as any;
    const res = createMockRes();
    const next = jest.fn();

    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

// isSystemAdmin

describe('isSystemAdmin', () => {
  it('returns true only when isSuperAdmin is true', () => {
    const req = createMockReq();
    req.user = { role: 'member', organizationId: 'org-acme', isSuperAdmin: true } as any;
    expect(isSystemAdmin(req)).toBe(true);
  });

  it('returns true even with no active org context', () => {
    const req = createMockReq();
    req.user = { role: 'member', isSuperAdmin: true } as any;
    expect(isSystemAdmin(req)).toBe(true);
  });

  it('returns false when isSuperAdmin is missing (no req.user)', () => {
    const req = createMockReq();
    expect(isSystemAdmin(req)).toBe(false);
  });

  it('returns false when isSuperAdmin is explicitly false', () => {
    const req = createMockReq();
    req.user = { role: 'admin', organizationId: 'org-acme', isSuperAdmin: false } as any;
    expect(isSystemAdmin(req)).toBe(false);
  });

  it('returns false for legacy admin in system org without isSuperAdmin flag', () => {
    // The legacy "membership in the system org grants sysadmin" branch is
    // removed — operators must be granted authority via the user-level flag.
    const req = createMockReq();
    req.user = { role: 'admin', organizationId: '000000000000000000000001' } as any;
    expect(isSystemAdmin(req)).toBe(false);
  });

  it('returns false for legacy owner in system org without isSuperAdmin flag', () => {
    const req = createMockReq();
    req.user = { role: 'owner', organizationId: '000000000000000000000001' } as any;
    expect(isSystemAdmin(req)).toBe(false);
  });
});

// resolveAccessModifier

describe('resolveAccessModifier', () => {
  it('should return "public" when system admin requests public', () => {
    const req = createMockReq();
    req.user = { role: 'admin', isSuperAdmin: true } as any;
    expect(resolveAccessModifier(req, 'public')).toBe('public');
  });

  it('should return "private" when non-admin requests public', () => {
    const req = createMockReq();
    req.user = { role: 'member' } as any;
    expect(resolveAccessModifier(req, 'public')).toBe('private');
  });

  it('should return "public" when an org admin (non-system) requests public', () => {
    // Org admins are now permitted to set 'public' — system admins create
    // catalog-wide entries, org admins create org-wide ones. Member role
    // and unauthenticated callers still get 'private'.
    const req = createMockReq();
    req.user = { role: 'admin', organizationId: 'some-org' } as any;
    expect(resolveAccessModifier(req, 'public')).toBe('public');
  });

  it('should return "private" when a member (non-admin) requests public', () => {
    const req = createMockReq();
    req.user = { role: 'member', organizationId: 'some-org' } as any;
    expect(resolveAccessModifier(req, 'public')).toBe('private');
  });

  it('should return "private" when private is requested', () => {
    const req = createMockReq();
    req.user = { role: 'admin', organizationId: '000000000000000000000001' } as any;
    expect(resolveAccessModifier(req, 'private')).toBe('private');
  });

  it('should return "private" when undefined is requested', () => {
    const req = createMockReq();
    req.user = { role: 'admin', organizationId: '000000000000000000000001' } as any;
    expect(resolveAccessModifier(req, undefined)).toBe('private');
  });
});

// signServiceToken / getServiceAuthHeader / isServicePrincipal
//
// Service tokens are minted by callers who can't forward a user JWT (cron,
// webhooks, queue workers). They must satisfy `requireAuth` end-to-end and
// be distinguishable from real user tokens via `isServicePrincipal`.

describe('signServiceToken', () => {
  it('mints a JWT verifiable with the shared JWT_SECRET', () => {
    const token = signServiceToken({ serviceName: 'billing', orgId: '000000000000000000000001', role: 'owner' });
    const decoded = jwt.verify(token, TEST_SECRET) as JwtPayload;
    expect(decoded.sub).toBe('service:billing');
    expect(decoded.username).toBe('billing-service');
    expect(decoded.organizationId).toBe('000000000000000000000001');
    expect(decoded.role).toBe('owner');
    expect(decoded.type).toBe('access');
    expect(decoded.isAdmin).toBe(true);
  });

  it('accepts a custom orgName (defaults to orgId)', () => {
    const token = signServiceToken({ serviceName: 'platform', orgId: 'org-1', orgName: 'Acme', role: 'owner' });
    const decoded = jwt.verify(token, TEST_SECRET) as JwtPayload;
    expect(decoded.organizationId).toBe('org-1');
    expect(decoded.organizationName).toBe('Acme');
  });

  it('defaults orgName to orgId when omitted', () => {
    const token = signServiceToken({ serviceName: 'compliance', orgId: '000000000000000000000001', role: 'owner' });
    const decoded = jwt.verify(token, TEST_SECRET) as JwtPayload;
    expect(decoded.organizationName).toBe('000000000000000000000001');
  });

  it('expires within the configured TTL (default 5 min)', () => {
    const token = signServiceToken({ serviceName: 'plugin', role: 'owner' });
    const decoded = jwt.verify(token, TEST_SECRET) as JwtPayload;
    expect(decoded.exp).toBeDefined();
    expect(decoded.iat).toBeDefined();
    const ttl = (decoded.exp as number) - (decoded.iat as number);
    expect(ttl).toBe(300); // default 5 min
  });

  it('honors custom ttlSeconds', () => {
    const token = signServiceToken({ serviceName: 'plugin', ttlSeconds: 60, role: 'owner' });
    const decoded = jwt.verify(token, TEST_SECRET) as JwtPayload;
    const ttl = (decoded.exp as number) - (decoded.iat as number);
    expect(ttl).toBe(60);
  });

  it('produces tokens that satisfy requireAuth without modification', (done) => {
    const token = signServiceToken({ serviceName: 'billing', orgId: '000000000000000000000001', role: 'owner' });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = createMockRes();
    requireAuth(req, res, () => {
      expect(req.user?.sub).toBe('service:billing');
      expect(req.user?.role).toBe('owner');
      done();
    });
  });

  it('rejects tokens signed with a different secret', () => {
    const wrongSecret = 'wrong-secret';
    const token = jwt.sign(
      { sub: 'service:evil', role: 'owner', type: 'access' },
      wrongSecret,
      { expiresIn: 60 },
    );
    expect(() => jwt.verify(token, TEST_SECRET)).toThrow();
  });
});

describe('getServiceAuthHeader', () => {
  it('returns "Bearer <jwt>" format', () => {
    const header = getServiceAuthHeader({ serviceName: 'billing', orgId: '000000000000000000000001', role: 'owner' });
    expect(header).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const token = header.slice(7);
    const decoded = jwt.verify(token, TEST_SECRET) as JwtPayload;
    expect(decoded.sub).toBe('service:billing');
  });
});

describe('isServicePrincipal', () => {
  it('returns true when sub starts with service:', () => {
    const req = createMockReq();
    req.user = { sub: 'service:billing', role: 'owner' } as any;
    expect(isServicePrincipal(req)).toBe(true);
  });

  it('returns false for a regular user JWT', () => {
    const req = createMockReq();
    req.user = { sub: '64f0e0a1b2c3d4e5f6a7b8c9', role: 'admin' } as any;
    expect(isServicePrincipal(req)).toBe(false);
  });

  it('returns false when req.user is undefined', () => {
    const req = createMockReq();
    expect(isServicePrincipal(req)).toBe(false);
  });
});

// verifyServicePrincipal
//
// A PRE-auth check (runs before requireAuth populates req.user) that
// CRYPTOGRAPHICALLY verifies the bearer token is a valid, signed SERVICE
// token. Unlike isServicePrincipal (which trusts an already-verified
// req.user.sub), this must not be fooled by an unsigned/tampered token or a
// spoofable header, since it gates things like rate-limiter bypass.

describe('verifyServicePrincipal', () => {
  it('returns true for a token minted by signServiceToken', () => {
    const token = signServiceToken({ serviceName: 'billing', orgId: 'org1', role: 'member' });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    expect(verifyServicePrincipal(req)).toBe(true);
  });

  it('returns false for a normal user access token (sub not service:)', () => {
    const token = signToken({ type: 'access', sub: 'user1', role: 'member' });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    expect(verifyServicePrincipal(req)).toBe(false);
  });

  it('returns false when the Authorization header is missing', () => {
    const req = createMockReq();
    expect(verifyServicePrincipal(req)).toBe(false);
  });

  it('returns false for a malformed Authorization header', () => {
    expect(verifyServicePrincipal(createMockReq({ headers: { authorization: 'Basic abc123' } }))).toBe(false);
    expect(verifyServicePrincipal(createMockReq({ headers: { authorization: 'Bearer' } }))).toBe(false);
    const token = signServiceToken({ serviceName: 'billing', orgId: 'org1', role: 'member' });
    // Extra segment → split length !== 2.
    expect(verifyServicePrincipal(createMockReq({ headers: { authorization: `Bearer ${token} extra` } }))).toBe(false);
  });

  it('returns false for a service token signed with the WRONG secret', () => {
    const token = jwt.sign(
      { sub: 'service:evil', role: 'owner', type: 'access' },
      'wrong-secret',
      { expiresIn: 60 },
    );
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    expect(verifyServicePrincipal(req)).toBe(false);
  });

  it('returns false for a tampered token', () => {
    const token = signServiceToken({ serviceName: 'billing', orgId: 'org1', role: 'member' });
    // Flip the last char of the signature to invalidate it.
    const tampered = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');
    const req = createMockReq({ headers: { authorization: `Bearer ${tampered}` } });
    expect(verifyServicePrincipal(req)).toBe(false);
  });

  it('returns false for a service-sub token that is NOT an access token', () => {
    // Correctly signed and service-scoped, but wrong token type → rejected.
    const token = signToken({ type: 'refresh', sub: 'service:billing', role: 'member' });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    expect(verifyServicePrincipal(req)).toBe(false);
  });
});

// Authorization-denial auditor (#5 — failed/denied attempt logging)

describe('setAuthzDenialAuditor', () => {
  function denialReq(overrides: Partial<Request> = {}): Request {
    return {
      headers: {},
      method: 'POST',
      originalUrl: '/pipelines/pl-1',
      user: { sub: 'u1', email: 'u1@example.com', organizationId: 'org-1', permissions: [] },
      ...overrides,
    } as unknown as Request;
  }

  afterEach(() => setAuthzDenialAuditor(undefined));

  it('fires on a requirePermission denial for a non-GET request with the required permission', () => {
    const seen: AuthzDenialInfo[] = [];
    setAuthzDenialAuditor((i) => seen.push(i));
    const res = createMockRes();
    requirePermission('pipelines:write')(denialReq(), res, jest.fn());
    expect(res._status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      actorId: 'u1',
      orgId: 'org-1',
      method: 'POST',
      path: '/pipelines/pl-1',
      required: 'pipelines:write',
    });
  });

  it('does NOT fire for a denied GET (low-signal probing noise)', () => {
    const fn = jest.fn();
    setAuthzDenialAuditor(fn);
    const res = createMockRes();
    requirePermission('pipelines:write')(denialReq({ method: 'GET' }), res, jest.fn());
    expect(res._status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });

  it('does NOT fire when the permission is granted', () => {
    const fn = jest.fn();
    setAuthzDenialAuditor(fn);
    const res = createMockRes();
    const next = jest.fn();
    const req = denialReq({ user: { sub: 'u1', permissions: ['pipelines:write'] } as unknown as JwtPayload });
    requirePermission('pipelines:write')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it('fires on a requireSystemAdmin denial with required=system-admin', () => {
    const seen: AuthzDenialInfo[] = [];
    setAuthzDenialAuditor((i) => seen.push(i));
    const res = createMockRes();
    requireSystemAdmin(denialReq(), res, jest.fn());
    expect(res._status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0].required).toBe('system-admin');
  });

  it('is best-effort: a throwing auditor does not break the gate', () => {
    setAuthzDenialAuditor(() => { throw new Error('audit sink down'); });
    const res = createMockRes();
    expect(() => requirePermission('pipelines:write')(denialReq(), res, jest.fn())).not.toThrow();
    expect(res._status).toBe(403);
  });

  it('does nothing when no auditor is registered', () => {
    const res = createMockRes();
    expect(() => requirePermission('pipelines:write')(denialReq(), res, jest.fn())).not.toThrow();
    expect(res._status).toBe(403);
  });
});

// Session-invalidation: token-revocation store (#1 option (b))

describe('setTokenRevocationStore + requireAuth revocation check', () => {
  const TV_SECRET = 'test-jwt-secret-for-unit-tests';
  afterEach(() => setTokenRevocationStore(undefined));

  function authReq(tokenVersion?: number) {
    const token = jwt.sign(
      { type: 'access', sub: 'user-x', role: 'member', organizationId: 'org1', tokenVersion },
      TV_SECRET,
    );
    return createMockReq({ headers: { authorization: `Bearer ${token}` } });
  }

  // Resolve once requireAuth reaches a terminal state (next() or a sent error).
  function runAuth(req: Request) {
    return new Promise<{ status: number; passed: boolean }>((resolve) => {
      const res = createMockRes();
      const origJson = res.json.bind(res);
      (res as any).json = (b: unknown) => { const r = origJson(b); resolve({ status: res._status, passed: false }); return r; };
      requireAuth(req, res, () => resolve({ status: 0, passed: true }));
    });
  }

  it('rejects a token whose tokenVersion is behind the store (revoked) with 401 TOKEN_REVOKED', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => 5 });
    const out = await runAuth(authReq(3));
    expect(out.passed).toBe(false);
    expect(out.status).toBe(401);
  });

  it('allows a token whose tokenVersion matches the store', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => 4 });
    expect((await runAuth(authReq(4))).passed).toBe(true);
  });

  it('allows on a store miss (null → no known revocation, fail-open)', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => null });
    expect((await runAuth(authReq(2))).passed).toBe(true);
  });

  it('allows when the store throws (fail-open, no lockout on Redis outage)', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => { throw new Error('redis down'); } });
    expect((await runAuth(authReq(2))).passed).toBe(true);
  });

  it('does no revocation check when no store is registered (backward compatible)', async () => {
    expect((await runAuth(authReq(1))).passed).toBe(true);
  });

  it('skips the check for a token with no tokenVersion (e.g. service tokens)', async () => {
    const store = { getCurrentVersion: jest.fn(async () => 9) };
    setTokenRevocationStore(store);
    expect((await runAuth(authReq(undefined))).passed).toBe(true);
    expect(store.getCurrentVersion).not.toHaveBeenCalled();
  });
});

// requireAllPermissions (AND semantics)

describe('requireAllPermissions', () => {
  afterEach(() => setAuthzDenialAuditor(undefined));

  function req(permissions: string[], isSuperAdmin = false) {
    return { method: 'POST', originalUrl: '/x', user: { sub: 'u', permissions, isSuperAdmin } } as unknown as Request;
  }

  it('passes when the user holds every required permission', () => {
    const res = createMockRes(); const next = jest.fn();
    requireAllPermissions('pipelines:read', 'pipelines:write')(req(['pipelines:read', 'pipelines:write']), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('403s when any one is missing (and lists only the missing one)', () => {
    const res = createMockRes(); const next = jest.fn();
    requireAllPermissions('pipelines:read', 'pipelines:write')(req(['pipelines:read']), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(JSON.stringify(res._json)).toContain('pipelines:write');
  });

  it('superadmin bypasses even with no explicit permissions', () => {
    const res = createMockRes(); const next = jest.fn();
    requireAllPermissions('pipelines:write', 'billing:write')(req([], true), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('fires the denial auditor on a missing-permission rejection', () => {
    const seen: unknown[] = [];
    setAuthzDenialAuditor((i) => seen.push(i));
    requireAllPermissions('a:write' as any, 'b:write' as any)(req(['a:write']), createMockRes(), jest.fn());
    expect(seen).toHaveLength(1);
  });
});

// signServiceToken hardening

describe('signServiceToken jti', () => {
  it('mints a unique jti on every call', () => {
    const a = jwt.decode(signServiceToken({ serviceName: 'billing', orgId: 'o', role: 'member' })) as any;
    const b = jwt.decode(signServiceToken({ serviceName: 'billing', orgId: 'o', role: 'member' })) as any;
    expect(typeof a.jti).toBe('string');
    expect(a.jti).not.toBe(b.jti);
  });
});
