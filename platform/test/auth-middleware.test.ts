// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock dependencies
import { jest, describe, it, expect, beforeEach, test } from '@jest/globals';
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    auth: {
      passwordMinLength: 8,
      jwt: {
        secret: 'test-jwt-secret',
        expiresIn: 7200,
        algorithm: 'HS256',
        saltRounds: 12,
      },
      refreshToken: {
        secret: 'test-refresh-secret',
        expiresIn: 2592000,
      },
    },
  },
}));

const mockFindById = jest.fn();
const mockOrgFindById = jest.fn();

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {
    findById: (...args: any[]) => mockFindById(...args),
  },
  Organization: {
    findById: (...args: any[]) => mockOrgFindById(...args),
  },
  UserOrganization: {},
}));

const { requireRole } = await import('../src/middleware/auth.js');


// Helpers

function mockRes() {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

function mockNext() {
  return jest.fn();
}

// Tests

describe('auth middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('requireRole', () => {
    it('should allow user with matching role', () => {
      const middleware = requireRole('admin');
      const req = { user: { role: 'admin' } } as any;
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should allow when role is in list', () => {
      const middleware = requireRole('member', 'admin');
      const req = { user: { role: 'member' } } as any;
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should deny when role is not in list', () => {
      const middleware = requireRole('admin');
      const req = { user: { role: 'member' } } as any;
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should deny when no user present', () => {
      const middleware = requireRole('admin');
      const req = {} as any;
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should allow a system admin even when their org role is not in the list', () => {
      // Platform superuser (isSuperAdmin) bypasses the org-role gate so admin/
      // owner routes (e.g. POST /organization) work for sysadmins.
      const middleware = requireRole('admin', 'owner');
      const req = { user: { role: 'member', isSuperAdmin: true } } as any;
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should still deny a non-sysadmin whose role is not in the list', () => {
      const middleware = requireRole('admin', 'owner');
      const req = { user: { role: 'member', isSuperAdmin: false } } as any;
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
