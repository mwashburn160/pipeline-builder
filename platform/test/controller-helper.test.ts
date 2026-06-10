// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock dependencies
import { jest, describe, it, expect, beforeEach, test } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: jest.fn(),
  // `isSystemAdmin` is re-exported from api-core into the platform helper;
  // mock it to match the production semantics (sysadmin iff JWT claim).
  isSystemAdmin: jest.fn((req: any) => req?.user?.isSuperAdmin === true),
  // `isOrgAdmin` uses `isSystemOrgId(orgId, orgName)` to exclude the legacy
  // 'system' content-holder org from being treated as a real tenant.
  isSystemOrgId: jest.fn(
    (orgId?: string, orgName?: string) =>
      orgId?.toLowerCase() === 'system' || orgName?.toLowerCase() === 'system',
  ),
}));

jest.unstable_mockModule('mongoose', () => {
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

const { sendError } = await import('@pipeline-builder/api-core');
const {
  isOrgAdmin,
  requireAuth,
  requireAuthUserId,
  requireSystemAdmin,
  requireOrgMembership,
  getAdminContext,
  requireAdminContext,
  handleControllerError,
  toOrgId,
} = await import('../src/helpers/controller-helper.js');

const mockSendError = sendError as jest.MockedFunction<typeof sendError>;

// Helpers
function mockReq(user?: Partial<{
  role: string;
  organizationId: string;
  organizationName: string;
  sub: string;
  isSuperAdmin: boolean;
}>, headers?: Record<string, string>) {
  return { user: user as any, headers: headers || {} } as any;
}

function mockRes() {
  return {} as any;
}

// Tests
describe('controller-helper', () => {
  beforeEach(() => jest.clearAllMocks());

  // isSystemAdmin is now re-exported from api-core; covered in api-core/test/auth.test.ts.
  // Local tests verify only the wrapper functions (isOrgAdmin, requireSystemAdmin, etc.).

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
      // Sysadmin authority comes from the `isSuperAdmin` JWT claim now;
      // org name/id is no longer a privilege source.
      expect(requireSystemAdmin(mockReq({ isSuperAdmin: true, sub: 'u1' }), mockRes())).toBe(true);
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
      // Sysadmin context is driven by the `isSuperAdmin` JWT claim, not org.
      const ctx = getAdminContext(mockReq({ isSuperAdmin: true }));
      expect(ctx.isSuperAdmin).toBe(true);
      expect(ctx.isOrgAdmin).toBe(false);
      expect(ctx.adminType).toBe('system admin');
    });

    it('should return org admin context', () => {
      const ctx = getAdminContext(mockReq({ role: 'admin', organizationId: 'org-1' }));
      expect(ctx.isSuperAdmin).toBe(false);
      expect(ctx.isOrgAdmin).toBe(true);
      expect(ctx.adminType).toBe('org admin');
    });
  });

  describe('requireAdminContext', () => {
    it('should return context for system admin', () => {
      const ctx = requireAdminContext(mockReq({ isSuperAdmin: true }), mockRes());
      expect(ctx).not.toBeNull();
      expect(ctx!.isSuperAdmin).toBe(true);
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
