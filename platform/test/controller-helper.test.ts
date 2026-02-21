// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------
jest.mock('@mwashburn160/api-core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  sendError: jest.fn(),
}));

jest.mock('mongoose', () => {
  const Types = {
    ObjectId: {
      isValid: jest.fn((id: string) => /^[0-9a-f]{24}$/i.test(id)),
    },
  };

  class MockObjectId {
    _id: string;
    constructor(id: string) { this._id = id; }
    toString() { return this._id; }
  }

  Types.ObjectId = Object.assign(MockObjectId, Types.ObjectId) as any;

  return {
    __esModule: true,
    default: { Types, startSession: jest.fn() },
    Types,
  };
});

import { sendError } from '@mwashburn160/api-core';
import {
  isSystemAdmin,
  isOrgAdmin,
  requireAuth,
  requireAuthUserId,
  requireSystemAdmin,
  requireOrgMembership,
  getAdminContext,
  requireAdminContext,
  getAuthContext,
  extractToken,
  mapMongooseError,
  handleControllerError,
  toOrgId,
} from '../src/helpers/controller-helper';

const mockSendError = sendError as jest.MockedFunction<typeof sendError>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockReq(user?: Partial<{
  role: string;
  organizationId: string;
  organizationName: string;
  sub: string;
}>, headers?: Record<string, string>) {
  return { user: user as any, headers: headers || {} } as any;
}

function mockRes() {
  return {} as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('controller-helper', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('isSystemAdmin', () => {
    it('should return true when role=admin and orgId=system', () => {
      expect(isSystemAdmin(mockReq({ role: 'admin', organizationId: 'system' }))).toBe(true);
    });

    it('should return true when role=admin and orgName=system', () => {
      expect(isSystemAdmin(mockReq({ role: 'admin', organizationName: 'system' }))).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(isSystemAdmin(mockReq({ role: 'admin', organizationId: 'SYSTEM' }))).toBe(true);
      expect(isSystemAdmin(mockReq({ role: 'admin', organizationName: 'System' }))).toBe(true);
    });

    it('should return false for non-admin role', () => {
      expect(isSystemAdmin(mockReq({ role: 'user', organizationId: 'system' }))).toBe(false);
    });

    it('should return false for admin in non-system org', () => {
      expect(isSystemAdmin(mockReq({ role: 'admin', organizationId: 'org-1' }))).toBe(false);
    });

    it('should return false when no user', () => {
      expect(isSystemAdmin(mockReq())).toBe(false);
    });
  });

  describe('isOrgAdmin', () => {
    it('should return true for admin in non-system org', () => {
      expect(isOrgAdmin(mockReq({ role: 'admin', organizationId: 'org-1' }))).toBe(true);
    });

    it('should return false for system admin', () => {
      expect(isOrgAdmin(mockReq({ role: 'admin', organizationId: 'system' }))).toBe(false);
    });

    it('should return false for non-admin', () => {
      expect(isOrgAdmin(mockReq({ role: 'user', organizationId: 'org-1' }))).toBe(false);
    });
  });

  describe('requireAuth', () => {
    it('should return true when user exists', () => {
      expect(requireAuth(mockReq({ sub: 'u1' }), mockRes())).toBe(true);
    });

    it('should return false and send 401 when no user', () => {
      const res = mockRes();
      expect(requireAuth(mockReq(), res)).toBe(false);
      expect(mockSendError).toHaveBeenCalledWith(res, 401, 'Unauthorized');
    });
  });

  describe('requireAuthUserId', () => {
    it('should return userId when present', () => {
      expect(requireAuthUserId(mockReq({ sub: 'user-123' }), mockRes())).toBe('user-123');
    });

    it('should return null and send 401 when no sub', () => {
      const res = mockRes();
      expect(requireAuthUserId(mockReq({}), res)).toBeNull();
      expect(mockSendError).toHaveBeenCalledWith(res, 401, 'Unauthorized');
    });

    it('should return null when no user', () => {
      expect(requireAuthUserId(mockReq(), mockRes())).toBeNull();
    });
  });

  describe('requireSystemAdmin', () => {
    it('should return true for system admin', () => {
      expect(requireSystemAdmin(mockReq({ role: 'admin', organizationId: 'system', sub: 'u1' }), mockRes())).toBe(true);
    });

    it('should return false and send 403 for org admin', () => {
      const res = mockRes();
      expect(requireSystemAdmin(mockReq({ role: 'admin', organizationId: 'org-1', sub: 'u1' }), res)).toBe(false);
      expect(mockSendError).toHaveBeenCalledWith(res, 403, expect.stringContaining('System admin'));
    });

    it('should return false and send 401 when no user', () => {
      const res = mockRes();
      expect(requireSystemAdmin(mockReq(), res)).toBe(false);
      expect(mockSendError).toHaveBeenCalledWith(res, 401, 'Unauthorized');
    });
  });

  describe('requireOrgMembership', () => {
    it('should return orgId when user has org', () => {
      expect(requireOrgMembership(mockReq({ sub: 'u1', organizationId: 'org-1' }), mockRes())).toBe('org-1');
    });

    it('should return null and send 400 when no org', () => {
      const res = mockRes();
      expect(requireOrgMembership(mockReq({ sub: 'u1' }), res)).toBeNull();
      expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.stringContaining('organization'));
    });

    it('should return null when not authenticated', () => {
      expect(requireOrgMembership(mockReq(), mockRes())).toBeNull();
    });
  });

  describe('getAdminContext', () => {
    it('should return system admin context', () => {
      const ctx = getAdminContext(mockReq({ role: 'admin', organizationId: 'system' }));
      expect(ctx.isSysAdmin).toBe(true);
      expect(ctx.isOrgAdmin).toBe(false);
      expect(ctx.adminType).toBe('system admin');
    });

    it('should return org admin context', () => {
      const ctx = getAdminContext(mockReq({ role: 'admin', organizationId: 'org-1' }));
      expect(ctx.isSysAdmin).toBe(false);
      expect(ctx.isOrgAdmin).toBe(true);
      expect(ctx.adminType).toBe('org admin');
    });
  });

  describe('requireAdminContext', () => {
    it('should return context for system admin', () => {
      const ctx = requireAdminContext(mockReq({ role: 'admin', organizationId: 'system' }), mockRes());
      expect(ctx).not.toBeNull();
      expect(ctx!.isSysAdmin).toBe(true);
    });

    it('should return context for org admin', () => {
      const ctx = requireAdminContext(mockReq({ role: 'admin', organizationId: 'org-1' }), mockRes());
      expect(ctx).not.toBeNull();
      expect(ctx!.isOrgAdmin).toBe(true);
    });

    it('should return null and send 403 for non-admin', () => {
      const res = mockRes();
      expect(requireAdminContext(mockReq({ role: 'user', organizationId: 'org-1' }), res)).toBeNull();
      expect(mockSendError).toHaveBeenCalledWith(res, 403, expect.stringContaining('Admin'));
    });

    it('should return null and send 401 when no user', () => {
      const res = mockRes();
      expect(requireAdminContext(mockReq(), res)).toBeNull();
      expect(mockSendError).toHaveBeenCalledWith(res, 401, 'Unauthorized');
    });
  });

  describe('getAuthContext', () => {
    it('should return full auth context', () => {
      const req = mockReq(
        { sub: 'u1', organizationId: 'org-1' },
        { authorization: 'Bearer my-token' },
      );
      const ctx = getAuthContext(req, mockRes(), 'list plugins');
      expect(ctx).toEqual({ userId: 'u1', orgId: 'org-1', token: 'my-token' });
    });

    it('should return null when no user', () => {
      const res = mockRes();
      expect(getAuthContext(mockReq(undefined, {}), res, 'test')).toBeNull();
      expect(mockSendError).toHaveBeenCalledWith(res, 401, 'Unauthorized');
    });

    it('should return null when no org', () => {
      const req = mockReq({ sub: 'u1' }, { authorization: 'Bearer tok' });
      const res = mockRes();
      expect(getAuthContext(req, res, 'create pipeline')).toBeNull();
      expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.stringContaining('organization'));
    });

    it('should return null when no authorization header', () => {
      const req = mockReq({ sub: 'u1', organizationId: 'org-1' }, {});
      const res = mockRes();
      expect(getAuthContext(req, res, 'test')).toBeNull();
      expect(mockSendError).toHaveBeenCalledWith(res, 401, expect.stringContaining('token'));
    });
  });

  describe('extractToken', () => {
    it('should extract Bearer token', () => {
      expect(extractToken(mockReq({}, { authorization: 'Bearer abc123' }))).toBe('abc123');
    });

    it('should return null for missing header', () => {
      expect(extractToken(mockReq({}, {}))).toBeNull();
    });

    it('should return null for non-Bearer scheme', () => {
      expect(extractToken(mockReq({}, { authorization: 'Basic abc123' }))).toBeNull();
    });

    it('should handle array authorization header', () => {
      const req = { headers: { authorization: ['Bearer tok1', 'Bearer tok2'] } } as any;
      expect(extractToken(req)).toBe('tok1');
    });
  });

  describe('mapMongooseError', () => {
    it('should map ValidationError', () => {
      const err = {
        name: 'ValidationError',
        errors: {
          email: { message: 'Email is required' },
          name: { message: 'Name is required' },
        },
      };
      const result = mapMongooseError(err);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(400);
      expect(result!.message).toContain('Email is required');
      expect(result!.code).toBe('VALIDATION_ERROR');
    });

    it('should map duplicate key error (E11000)', () => {
      const err = { code: 11000, keyPattern: { email: 1 } };
      const result = mapMongooseError(err);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(409);
      expect(result!.message).toContain('email');
      expect(result!.code).toBe('DUPLICATE_KEY');
    });

    it('should map CastError', () => {
      const err = { name: 'CastError', path: '_id', value: 'not-valid' };
      const result = mapMongooseError(err);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(400);
      expect(result!.code).toBe('INVALID_ID');
    });

    it('should return null for unknown errors', () => {
      expect(mapMongooseError(new Error('random'))).toBeNull();
    });

    it('should return null for null/undefined', () => {
      expect(mapMongooseError(null)).toBeNull();
      expect(mapMongooseError(undefined)).toBeNull();
    });
  });

  describe('handleControllerError', () => {
    it('should use error map when message matches', () => {
      const res = mockRes();
      const err = new Error('EMAIL_TAKEN');
      const errorMap = { EMAIL_TAKEN: { status: 409, message: 'Email already in use' } };

      handleControllerError(res, err, 'Registration failed', errorMap);

      expect(mockSendError).toHaveBeenCalledWith(res, 409, 'Email already in use');
    });

    it('should handle Mongoose errors', () => {
      const res = mockRes();
      const err = { code: 11000, keyPattern: { username: 1 } };

      handleControllerError(res, err, 'Update failed');

      expect(mockSendError).toHaveBeenCalledWith(res, 409, expect.stringContaining('username'), 'DUPLICATE_KEY');
    });

    it('should handle ServiceError', () => {
      const res = mockRes();
      const err = { name: 'ServiceError', statusCode: 502, message: 'Upstream down', code: 'SERVICE_DOWN' };

      handleControllerError(res, err, 'Request failed');

      expect(mockSendError).toHaveBeenCalledWith(res, 502, 'Upstream down', 'SERVICE_DOWN');
    });

    it('should fallback to 500 for unknown errors', () => {
      const res = mockRes();
      handleControllerError(res, new Error('oops'), 'Something went wrong');

      expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Something went wrong');
    });
  });

  describe('toOrgId', () => {
    it('should convert valid 24-char hex to ObjectId', () => {
      const id = '507f1f77bcf86cd799439011';
      const result = toOrgId(id);
      expect(result.toString()).toBe(id);
    });

    it('should return string for non-ObjectId values', () => {
      expect(toOrgId('system')).toBe('system');
    });

    it('should handle array input', () => {
      const id = '507f1f77bcf86cd799439011';
      const result = toOrgId([id]);
      expect(result.toString()).toBe(id);
    });

    it('should return short strings as-is', () => {
      expect(toOrgId('abc')).toBe('abc');
    });
  });
});
