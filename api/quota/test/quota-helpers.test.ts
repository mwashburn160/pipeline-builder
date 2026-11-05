// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mock config BEFORE importing helpers (config is required at import time)
jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    quota: {
      defaults: { plugins: 100, pipelines: 10, apiCalls: -1 },
      resetDays: 3,
    },
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: jest.fn(),
  DEFAULT_TIER: 'developer',
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'] as const,
  QUOTA_TIERS: {
    developer: { limits: { plugins: 100, pipelines: 10, apiCalls: -1 } },
    pro: { limits: { plugins: 500, pipelines: 50, apiCalls: -1 } },
    unlimited: { limits: { plugins: -1, pipelines: -1, apiCalls: -1 } },
  },
  VALID_TIERS: ['developer', 'pro', 'team', 'enterprise'],
  isValidTier: jest.fn((t: string) => ['developer', 'pro', 'team', 'enterprise'].includes(t)),
  getTierLimits: jest.fn(),
  isValidQuotaType: jest.fn((t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t)),
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  isSystemAdmin: jest.fn(() => false),
}));

const {
  computeQuotaStatus,
  applyQuotaLimits,
  buildOrgQuotaResponse,
  buildDefaultOrgQuotaResponse,
  buildReserveResult,
} = await import('../src/helpers/quota-helpers.js');

// Tests

describe('quota-helpers', () => {
  describe('computeQuotaStatus — caps only RISE mid-period', () => {
    /**
     * The rule that makes `checkEntitlementOvercap`'s exclusion of per-period
     * rate quotas honest again. Its reason — "they reset, so landing over a
     * reduced cap costs at most one period" — holds at three days and breaks at
     * a MONTH, which is what `cpuCredits` rolls on: a mid-month downgrade or a
     * cancelled pack could otherwise refuse every build until the window rolled.
     */
    const future = () => { const d = new Date(); d.setDate(d.getDate() + 3); return d; };
    const past = () => { const d = new Date(); d.setDate(d.getDate() - 1); return d; };

    it('keeps the HIGHER cap when the limit was reduced mid-period', () => {
      // Started the period with 1000, downgraded to 100, already spent 400.
      const status = computeQuotaStatus(100, { used: 400, resetAt: future(), limitAtPeriodStart: 1000 });
      // The account is NOT stranded: it keeps the cap it spent against.
      expect(status).toMatchObject({ limit: 1000, used: 400, remaining: 600, allowed: true });
    });

    it('takes a mid-period UPGRADE immediately', () => {
      // The max cuts both ways: buying a pack must apply now, not next window.
      const status = computeQuotaStatus(2000, { used: 400, resetAt: future(), limitAtPeriodStart: 1000 });
      expect(status).toMatchObject({ limit: 2000, remaining: 1600, allowed: true });
    });

    it('applies the REDUCED cap once the period has expired', () => {
      // An expired window starts at whatever the account holds now — which is
      // how a downgrade eventually takes effect rather than never.
      const status = computeQuotaStatus(100, { used: 400, resetAt: past(), limitAtPeriodStart: 1000 });
      expect(status).toMatchObject({ limit: 100, used: 0, remaining: 100, allowed: true });
    });

    it('falls back to the current limit when there is no snapshot', () => {
      // Counters predating the field, which must behave exactly as before.
      const status = computeQuotaStatus(100, { used: 40, resetAt: future() });
      expect(status).toMatchObject({ limit: 100, remaining: 60, allowed: true });
    });

    it('treats unlimited on either side as unlimited', () => {
      // -1 is a sentinel, not a number: Math.max(-1, 100) would be 100 and would
      // silently CAP an account that holds an unlimited entitlement.
      expect(computeQuotaStatus(-1, { used: 9_999, resetAt: future(), limitAtPeriodStart: 100 }))
        .toMatchObject({ limit: -1, remaining: -1, unlimited: true, allowed: true });
      expect(computeQuotaStatus(100, { used: 9_999, resetAt: future(), limitAtPeriodStart: -1 }))
        .toMatchObject({ limit: -1, remaining: -1, unlimited: true, allowed: true });
    });

    it('refuses once usage passes the EFFECTIVE cap, not the nominal one', () => {
      const status = computeQuotaStatus(100, { used: 1200, resetAt: future(), limitAtPeriodStart: 1000 });
      expect(status).toMatchObject({ limit: 1000, remaining: 0, allowed: false });
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

describe('buildReserveResult', () => {
  const resetAt = new Date('2026-01-04T00:00:00.000Z');

  it("maps the named outcome onto `exceeded`, so a call site can't invert it silently", () => {
    // The outcome used to be a bare trailing boolean, indistinguishable at the
    // call site from the three numbers before it.
    expect(buildReserveResult('plugins', 100, 40, resetAt, 'allowed').exceeded).toBe(false);
    expect(buildReserveResult('plugins', 100, 100, resetAt, 'exceeded').exceeded).toBe(true);
  });

  it('computes remaining from limit and used', () => {
    const result = buildReserveResult('plugins', 100, 40, resetAt, 'allowed');
    expect(result.quota).toEqual({
      type: 'plugins',
      limit: 100,
      used: 40,
      remaining: 60,
      resetAt: '2026-01-04T00:00:00.000Z',
    });
  });

  it('floors remaining at 0 rather than reporting a negative allowance', () => {
    expect(buildReserveResult('plugins', 10, 25, resetAt, 'exceeded').quota.remaining).toBe(0);
  });

  it('reports unlimited (-1) as -1 remaining, never limit - used', () => {
    expect(buildReserveResult('apiCalls', -1, 9999, resetAt, 'allowed').quota.remaining).toBe(-1);
  });

  it('accepts an ISO string resetAt and omits it entirely when absent', () => {
    expect(buildReserveResult('plugins', 5, 1, '2026-01-04T00:00:00.000Z', 'allowed').quota.resetAt)
      .toBe('2026-01-04T00:00:00.000Z');
    expect(buildReserveResult('plugins', 5, 1, undefined, 'allowed').quota.resetAt).toBeUndefined();
  });
});
