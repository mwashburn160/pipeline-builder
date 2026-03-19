import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, requireOrganization, requireAdmin, isSystemAdmin, isSystemOrg, resolveAccessModifier } from '../src/middleware/auth';

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
    const payload = { type: 'access', sub: 'user1', role: 'user', organizationId: 'org1' };
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
    const payload = { type: 'access', sub: 'user1', role: 'user', organizationId: 'org1' };
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
    const payload = { type: 'access', sub: 'user1', role: 'user', organizationId: 'org1' };
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

// requireOrganization

describe('requireOrganization', () => {
  it('should reject when no user', () => {
    const req = createMockReq();
    const res = createMockRes();
    const next = jest.fn();

    requireOrganization(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject when user has no organizationId', () => {
    const req = createMockReq();
    req.user = { sub: 'user1', role: 'user' } as any;
    const res = createMockRes();
    const next = jest.fn();

    requireOrganization(req, res, next);

    expect(res._status).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('should call next when user has organizationId', () => {
    const req = createMockReq();
    req.user = { sub: 'user1', role: 'user', organizationId: 'org1' } as any;
    const res = createMockRes();
    const next = jest.fn();

    requireOrganization(req, res, next);

    expect(next).toHaveBeenCalled();
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
    req.user = { sub: 'user1', role: 'user' } as any;
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
    req.user = { role: 'user', organizationId: 'system' } as any;
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
    req.user = { role: 'user', organizationId: 'system' } as any;
    expect(resolveAccessModifier(req, 'public')).toBe('private');
  });

  it('should return "private" when admin in non-system org requests public', () => {
    const req = createMockReq();
    req.user = { role: 'admin', organizationId: 'some-org' } as any;
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
