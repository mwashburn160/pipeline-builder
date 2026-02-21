// ---------------------------------------------------------------------------
// Mock config BEFORE importing helpers (config is required at import time)
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
  sendError: jest.fn(),
  ErrorCode: {
    ORG_NOT_FOUND: 'ORG_NOT_FOUND',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  },
  DEFAULT_TIER: 'developer',
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'] as const,
  QUOTA_TIERS: {
    developer: { limits: { plugins: 100, pipelines: 10, apiCalls: -1 } },
    pro: { limits: { plugins: 500, pipelines: 50, apiCalls: -1 } },
    unlimited: { limits: { plugins: -1, pipelines: -1, apiCalls: -1 } },
  },
  VALID_TIERS: ['developer', 'pro', 'unlimited'],
  isValidTier: jest.fn((t: string) => ['developer', 'pro', 'unlimited'].includes(t)),
  getTierLimits: jest.fn(),
  isValidQuotaType: jest.fn((t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t)),
}));

import {
  getNextResetDate,
  validateQuotaValues,
  computeQuotaStatus,
  sendOrgNotFound,
  sendInvalidQuotaType,
  sendMissingOrgId,
  applyQuotaLimits,
  buildOrgQuotaResponse,
  buildDefaultOrgQuotaResponse,
  AUTH_OPTS,
} from '../src/helpers/quota-helpers';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('quota-helpers', () => {
  describe('AUTH_OPTS', () => {
    it('should allow org header override', () => {
      expect(AUTH_OPTS).toEqual({ allowOrgHeaderOverride: true });
    });
  });

  describe('getNextResetDate', () => {
    it('should return a date N days from now at midnight', () => {
      const result = getNextResetDate(3);
      const now = new Date();

      expect(result.getHours()).toBe(0);
      expect(result.getMinutes()).toBe(0);
      expect(result.getSeconds()).toBe(0);
      expect(result.getMilliseconds()).toBe(0);

      // Should be approximately 3 days from now
      const diffMs = result.getTime() - now.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThanOrEqual(2);
      expect(diffDays).toBeLessThanOrEqual(3.1);
    });

    it('should handle 0 days', () => {
      const result = getNextResetDate(0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      expect(result.getTime()).toBe(today.getTime());
    });

    it('should handle large values', () => {
      const result = getNextResetDate(365);
      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(0);
    });
  });

  describe('validateQuotaValues', () => {
    it('should return empty array for valid values', () => {
      const errors = validateQuotaValues({ plugins: 10, pipelines: 5, apiCalls: -1 });
      expect(errors).toEqual([]);
    });

    it('should accept -1 as unlimited', () => {
      const errors = validateQuotaValues({ plugins: -1 });
      expect(errors).toEqual([]);
    });

    it('should accept 0 as valid', () => {
      const errors = validateQuotaValues({ plugins: 0 });
      expect(errors).toEqual([]);
    });

    it('should reject non-integer numbers', () => {
      const errors = validateQuotaValues({ plugins: 1.5 });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('plugins');
    });

    it('should reject values less than -1', () => {
      const errors = validateQuotaValues({ pipelines: -2 });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('pipelines');
    });

    it('should reject non-number values', () => {
      const errors = validateQuotaValues({ apiCalls: 'abc' as any });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('apiCalls');
    });

    it('should skip undefined values', () => {
      const errors = validateQuotaValues({ plugins: undefined as any });
      expect(errors).toEqual([]);
    });

    it('should report multiple errors', () => {
      const errors = validateQuotaValues({
        plugins: -5,
        pipelines: 'invalid' as any,
      });
      expect(errors.length).toBe(2);
    });
  });

  describe('computeQuotaStatus', () => {
    it('should compute status for normal usage', () => {
      const future = new Date();
      future.setDate(future.getDate() + 3);

      const status = computeQuotaStatus(100, { used: 40, resetAt: future });

      expect(status.limit).toBe(100);
      expect(status.used).toBe(40);
      expect(status.remaining).toBe(60);
      expect(status.allowed).toBe(true);
      expect(status.unlimited).toBe(false);
    });

    it('should handle unlimited quota (-1)', () => {
      const future = new Date();
      future.setDate(future.getDate() + 1);

      const status = computeQuotaStatus(-1, { used: 9999, resetAt: future });

      expect(status.limit).toBe(-1);
      expect(status.remaining).toBe(-1);
      expect(status.allowed).toBe(true);
      expect(status.unlimited).toBe(true);
    });

    it('should report not allowed when limit reached', () => {
      const future = new Date();
      future.setDate(future.getDate() + 1);

      const status = computeQuotaStatus(10, { used: 10, resetAt: future });

      expect(status.allowed).toBe(false);
      expect(status.remaining).toBe(0);
    });

    it('should report not allowed when limit exceeded', () => {
      const future = new Date();
      future.setDate(future.getDate() + 1);

      const status = computeQuotaStatus(5, { used: 7, resetAt: future });

      expect(status.allowed).toBe(false);
      expect(status.remaining).toBe(0);
    });

    it('should auto-reset usage when resetAt is in the past', () => {
      const past = new Date();
      past.setDate(past.getDate() - 1);

      const status = computeQuotaStatus(100, { used: 50, resetAt: past });

      expect(status.used).toBe(0);
      expect(status.remaining).toBe(100);
      expect(status.allowed).toBe(true);
    });

    it('should handle zero limit', () => {
      const future = new Date();
      future.setDate(future.getDate() + 1);

      const status = computeQuotaStatus(0, { used: 0, resetAt: future });

      expect(status.remaining).toBe(0);
      expect(status.allowed).toBe(false);
    });
  });

  describe('error helpers', () => {
    const { sendError } = jest.requireMock('@mwashburn160/api-core');
    const res = {} as any;

    beforeEach(() => {
      sendError.mockClear();
    });

    it('sendOrgNotFound should send 404', () => {
      sendOrgNotFound(res);
      expect(sendError).toHaveBeenCalledWith(res, 404, expect.stringContaining('not found'), 'ORG_NOT_FOUND');
    });

    it('sendInvalidQuotaType should send 400', () => {
      sendInvalidQuotaType(res);
      expect(sendError).toHaveBeenCalledWith(res, 400, expect.stringContaining('Invalid quota type'), 'VALIDATION_ERROR');
    });

    it('sendMissingOrgId should send 400', () => {
      sendMissingOrgId(res);
      expect(sendError).toHaveBeenCalledWith(res, 400, expect.stringContaining('Organization ID'), 'MISSING_REQUIRED_FIELD');
    });
  });

  describe('applyQuotaLimits', () => {
    it('should apply partial quota updates to org', () => {
      const org = {
        quotas: { plugins: 10, pipelines: 5, apiCalls: 100 },
      } as any;

      applyQuotaLimits(org, { plugins: 50 });

      expect(org.quotas.plugins).toBe(50);
      expect(org.quotas.pipelines).toBe(5); // unchanged
      expect(org.quotas.apiCalls).toBe(100); // unchanged
    });

    it('should apply unlimited (-1) quota', () => {
      const org = {
        quotas: { plugins: 10, pipelines: 5, apiCalls: 100 },
      } as any;

      applyQuotaLimits(org, { plugins: -1, pipelines: -1, apiCalls: -1 });

      expect(org.quotas.plugins).toBe(-1);
      expect(org.quotas.pipelines).toBe(-1);
      expect(org.quotas.apiCalls).toBe(-1);
    });

    it('should skip undefined values', () => {
      const org = {
        quotas: { plugins: 10, pipelines: 5, apiCalls: 100 },
      } as any;

      applyQuotaLimits(org, {});

      expect(org.quotas.plugins).toBe(10);
      expect(org.quotas.pipelines).toBe(5);
      expect(org.quotas.apiCalls).toBe(100);
    });
  });

  describe('buildOrgQuotaResponse', () => {
    it('should build response from org document', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 3);

      const org = {
        _id: 'org-123',
        name: 'Test Org',
        slug: 'test-org',
        tier: 'pro',
        quotas: { plugins: 500, pipelines: 50, apiCalls: -1 },
        usage: {
          plugins: { used: 10, resetAt: futureDate },
          pipelines: { used: 5, resetAt: futureDate },
          apiCalls: { used: 100, resetAt: futureDate },
        },
      } as any;

      const result = buildOrgQuotaResponse(org);

      expect(result.orgId).toBe('org-123');
      expect(result.name).toBe('Test Org');
      expect(result.slug).toBe('test-org');
      expect(result.tier).toBe('pro');
      expect(result.quotas.plugins.limit).toBe(500);
      expect(result.quotas.plugins.used).toBe(10);
      expect(result.quotas.plugins.remaining).toBe(490);
      expect(result.quotas.apiCalls.unlimited).toBe(true);
    });

    it('should default tier to developer when not set', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 3);

      const org = {
        _id: 'org-1',
        name: 'No Tier',
        slug: 'no-tier',
        tier: undefined,
        quotas: { plugins: 100, pipelines: 10, apiCalls: -1 },
        usage: {
          plugins: { used: 0, resetAt: futureDate },
          pipelines: { used: 0, resetAt: futureDate },
          apiCalls: { used: 0, resetAt: futureDate },
        },
      } as any;

      const result = buildOrgQuotaResponse(org);
      expect(result.tier).toBe('developer');
    });
  });

  describe('buildDefaultOrgQuotaResponse', () => {
    it('should build default response with config defaults', () => {
      const result = buildDefaultOrgQuotaResponse('org-unknown');

      expect(result.orgId).toBe('org-unknown');
      expect(result.name).toBe('');
      expect(result.slug).toBe('');
      expect(result.tier).toBe('developer');
      expect(result.isDefault).toBe(true);
      expect(result.quotas.plugins.limit).toBe(100);
      expect(result.quotas.pipelines.limit).toBe(10);
      expect(result.quotas.apiCalls.limit).toBe(-1);
      expect(result.quotas.apiCalls.unlimited).toBe(true);
    });

    it('should have zero usage in default response', () => {
      const result = buildDefaultOrgQuotaResponse('new-org');

      expect(result.quotas.plugins.used).toBe(0);
      expect(result.quotas.pipelines.used).toBe(0);
      expect(result.quotas.apiCalls.used).toBe(0);
    });
  });
});
