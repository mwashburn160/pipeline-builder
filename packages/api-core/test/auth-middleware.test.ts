// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
  requireAuth, requireAdmin, isSystemAdmin, isSystemOrg, resolveAccessModifier,
  signServiceToken, getServiceAuthHeader, isServicePrincipal,
} from '../src/middleware/auth';
import type { JwtPayload } from '../src/types/common';

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

  it('should apply org header override when enabled', () => {
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

// isSystemOrg / isSystemAdmin

describe('isSystemOrg', () => {
  it('should return false when no user', () => {
    const req = createMockReq();
    expect(isSystemOrg(req)).toBe(false);
  });

  it('should return true when organizationId is "system"', () => {
    const req = createMockReq();
    req.user = { organizationId: 'system' } as any;
    expect(isSystemOrg(req)).toBe(true);
  });

  it('should return true when organizationId is "System" (case-insensitive)', () => {
    const req = createMockReq();
    req.user = { organizationId: 'System' } as any;
    expect(isSystemOrg(req)).toBe(true);
  });

  it('should return true when organizationName is "system"', () => {
    const req = createMockReq();
    req.user = { organizationName: 'system' } as any;
    expect(isSystemOrg(req)).toBe(true);
  });

  it('should return false for non-system org', () => {
    const req = createMockReq();
    req.user = { organizationId: 'some-org' } as any;
    expect(isSystemOrg(req)).toBe(false);
  });
});

describe('isSystemAdmin', () => {
  it('should return false when not admin', () => {
    const req = createMockReq();
    req.user = { role: 'member', organizationId: 'system' } as any;
    expect(isSystemAdmin(req)).toBe(false);
  });

  it('should return false when admin but not system org', () => {
    const req = createMockReq();
    req.user = { role: 'admin', organizationId: 'some-org' } as any;
    expect(isSystemAdmin(req)).toBe(false);
  });

  it('should return true when admin in system org', () => {
    const req = createMockReq();
    req.user = { role: 'admin', organizationId: 'system' } as any;
    expect(isSystemAdmin(req)).toBe(true);
  });

  it('should return true when owner in system org', () => {
    const req = createMockReq();
    req.user = { role: 'owner', organizationId: 'system' } as any;
    expect(isSystemAdmin(req)).toBe(true);
  });
});

// resolveAccessModifier

describe('resolveAccessModifier', () => {
  it('should return "public" when system admin requests public', () => {
    const req = createMockReq();
    req.user = { role: 'admin', organizationId: 'system' } as any;
    expect(resolveAccessModifier(req, 'public')).toBe('public');
  });

  it('should return "private" when non-admin requests public', () => {
    const req = createMockReq();
    req.user = { role: 'member', organizationId: 'system' } as any;
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
    req.user = { role: 'admin', organizationId: 'system' } as any;
    expect(resolveAccessModifier(req, 'private')).toBe('private');
  });

  it('should return "private" when undefined is requested', () => {
    const req = createMockReq();
    req.user = { role: 'admin', organizationId: 'system' } as any;
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
    const token = signServiceToken({ serviceName: 'billing', orgId: 'system' });
    const decoded = jwt.verify(token, TEST_SECRET) as JwtPayload;
    expect(decoded.sub).toBe('service:billing');
    expect(decoded.username).toBe('billing-service');
    expect(decoded.organizationId).toBe('system');
    expect(decoded.role).toBe('owner');
    expect(decoded.type).toBe('access');
    expect(decoded.isAdmin).toBe(true);
  });

  it('accepts a custom orgName (defaults to orgId)', () => {
    const token = signServiceToken({ serviceName: 'platform', orgId: 'org-1', orgName: 'Acme' });
    const decoded = jwt.verify(token, TEST_SECRET) as JwtPayload;
    expect(decoded.organizationId).toBe('org-1');
    expect(decoded.organizationName).toBe('Acme');
  });

  it('defaults orgName to orgId when omitted', () => {
    const token = signServiceToken({ serviceName: 'compliance', orgId: 'system' });
    const decoded = jwt.verify(token, TEST_SECRET) as JwtPayload;
    expect(decoded.organizationName).toBe('system');
  });

  it('expires within the configured TTL (default 5 min)', () => {
    const token = signServiceToken({ serviceName: 'plugin' });
    const decoded = jwt.verify(token, TEST_SECRET) as JwtPayload;
    expect(decoded.exp).toBeDefined();
    expect(decoded.iat).toBeDefined();
    const ttl = (decoded.exp as number) - (decoded.iat as number);
    expect(ttl).toBe(300); // default 5 min
  });

  it('honors custom ttlSeconds', () => {
    const token = signServiceToken({ serviceName: 'plugin', ttlSeconds: 60 });
    const decoded = jwt.verify(token, TEST_SECRET) as JwtPayload;
    const ttl = (decoded.exp as number) - (decoded.iat as number);
    expect(ttl).toBe(60);
  });

  it('produces tokens that satisfy requireAuth without modification', (done) => {
    const token = signServiceToken({ serviceName: 'billing', orgId: 'system' });
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
    const header = getServiceAuthHeader({ serviceName: 'billing', orgId: 'system' });
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
