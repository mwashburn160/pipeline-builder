// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------
jest.mock('../src/config', () => ({
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

jest.mock('../src/models', () => ({
  User: {
    findById: (...args: any[]) => mockFindById(...args),
  },
  Organization: {
    findById: (...args: any[]) => mockOrgFindById(...args),
  },
}));

import { isOrgMember, authorize } from '../src/middleware/auth.middleware';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('isOrgMember', () => {
    it('should call next when user belongs to the org', () => {
      const req = {
        user: { organizationId: 'org-1', role: 'user' },
        params: { orgId: 'org-1' },
        body: {},
      } as any;
      const res = mockRes();
      const next = mockNext();

      isOrgMember(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should allow admin to access any org', () => {
      const req = {
        user: { organizationId: 'system', role: 'admin' },
        params: { orgId: 'org-1' },
        body: {},
      } as any;
      const res = mockRes();
      const next = mockNext();

      isOrgMember(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should deny non-admin cross-org access', () => {
      const req = {
        user: { organizationId: 'org-2', role: 'user' },
        params: { orgId: 'org-1' },
        body: {},
      } as any;
      const res = mockRes();
      const next = mockNext();

      isOrgMember(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should deny user with no organizationId', () => {
      const req = {
        user: { role: 'user' },
        params: { orgId: 'org-1' },
        body: {},
      } as any;
      const res = mockRes();
      const next = mockNext();

      isOrgMember(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should use body.organizationId when params.orgId is missing', () => {
      const req = {
        user: { organizationId: 'org-1', role: 'user' },
        params: {},
        body: { organizationId: 'org-1' },
      } as any;
      const res = mockRes();
      const next = mockNext();

      isOrgMember(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('authorize', () => {
    it('should allow user with matching role', () => {
      const middleware = authorize('admin');
      const req = { user: { role: 'admin' } } as any;
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should allow when role is in list', () => {
      const middleware = authorize('user', 'admin');
      const req = { user: { role: 'user' } } as any;
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should deny when role is not in list', () => {
      const middleware = authorize('admin');
      const req = { user: { role: 'user' } } as any;
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should deny when no user present', () => {
      const middleware = authorize('admin');
      const req = {} as any;
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
