// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------
jest.mock('../src/config', () => ({
  config: {
    quota: {
      defaults: { plugins: 100, pipelines: 10, apiCalls: -1 },
      resetDays: 3,
    },
  },
}));

jest.mock('@mwashburn160/api-core', () => ({
  isSystemAdmin: jest.fn(),
  sendError: jest.fn(),
  ErrorCode: {
    UNAUTHORIZED: 'UNAUTHORIZED',
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    ORG_NOT_FOUND: 'ORG_NOT_FOUND',
  },
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  DEFAULT_TIER: 'developer',
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'] as const,
  QUOTA_TIERS: {},
  VALID_TIERS: ['developer', 'pro', 'unlimited'],
  isValidTier: jest.fn(),
  getTierLimits: jest.fn(),
  isValidQuotaType: jest.fn(),
}));

import { isSystemAdmin, sendError } from '@mwashburn160/api-core';
import { authorizeOrg } from '../src/middleware/authorize-org';

const mockIsSystemAdmin = isSystemAdmin as jest.MockedFunction<typeof isSystemAdmin>;
const mockSendError = sendError as jest.MockedFunction<typeof sendError>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockReqResNext(overrides: {
  user?: { organizationId?: string; role?: string };
  params?: Record<string, string>;
} = {}) {
  const req = {
    user: overrides.user,
    params: overrides.params || {},
  } as any;
  const res = {} as any;
  const next = jest.fn();
  return { req, res, next };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('authorizeOrg', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('default options (same-org or system admin)', () => {
    const middleware = authorizeOrg();

    it('should allow same-org access', () => {
      mockIsSystemAdmin.mockReturnValue(false);
      const { req, res, next } = createMockReqResNext({
        user: { organizationId: 'org-1' },
        params: { orgId: 'org-1' },
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(mockSendError).not.toHaveBeenCalled();
    });

    it('should allow same-org access case-insensitively', () => {
      mockIsSystemAdmin.mockReturnValue(false);
      const { req, res, next } = createMockReqResNext({
        user: { organizationId: 'ORG-1' },
        params: { orgId: 'org-1' },
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should allow system admin cross-org access', () => {
      mockIsSystemAdmin.mockReturnValue(true);
      const { req, res, next } = createMockReqResNext({
        user: { organizationId: 'system' },
        params: { orgId: 'org-1' },
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should deny cross-org access for non-admin', () => {
      mockIsSystemAdmin.mockReturnValue(false);
      const { req, res, next } = createMockReqResNext({
        user: { organizationId: 'org-2' },
        params: { orgId: 'org-1' },
      });

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(mockSendError).toHaveBeenCalledWith(res, 403, expect.any(String), 'INSUFFICIENT_PERMISSIONS');
    });

    it('should return 401 when no user present', () => {
      const { req, res, next } = createMockReqResNext({ user: undefined });

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(mockSendError).toHaveBeenCalledWith(res, 401, expect.any(String), 'UNAUTHORIZED');
    });

    it('should return 400 when user has no organizationId', () => {
      const { req, res, next } = createMockReqResNext({
        user: { organizationId: undefined },
        params: { orgId: 'org-1' },
      });

      // sendMissingOrgId is called (which calls sendError internally)
      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 400 when orgId param is missing', () => {
      const { req, res, next } = createMockReqResNext({
        user: { organizationId: 'org-1' },
        params: {},
      });

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requireSystemAdmin option', () => {
    const middleware = authorizeOrg({ requireSystemAdmin: true });

    it('should allow system admin', () => {
      mockIsSystemAdmin.mockReturnValue(true);
      const { req, res, next } = createMockReqResNext({
        user: { organizationId: 'system' },
        params: { orgId: 'org-1' },
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should deny same-org non-admin', () => {
      mockIsSystemAdmin.mockReturnValue(false);
      const { req, res, next } = createMockReqResNext({
        user: { organizationId: 'org-1' },
        params: { orgId: 'org-1' },
      });

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(mockSendError).toHaveBeenCalledWith(res, 403, expect.stringContaining('system administrator'), 'INSUFFICIENT_PERMISSIONS');
    });

    it('should deny cross-org non-admin', () => {
      mockIsSystemAdmin.mockReturnValue(false);
      const { req, res, next } = createMockReqResNext({
        user: { organizationId: 'org-2' },
        params: { orgId: 'org-1' },
      });

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(mockSendError).toHaveBeenCalledWith(res, 403, expect.any(String), 'INSUFFICIENT_PERMISSIONS');
    });
  });
});
