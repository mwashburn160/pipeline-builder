// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the quota service client — the fail-open / fail-closed
 * enforcement policy that gates paid resources.
 *
 * The client talks to the quota service through `createSafeClient` (from
 * services/http-client.js), which returns a parsed `{ statusCode, body }` for a
 * REACHABLE response (including 4xx/5xx) and `null` when the service is
 * UNREACHABLE (connection error / timeout). We mock at that boundary so the
 * tests exercise the real fail-open vs fail-closed branching in quota.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { QuotaTier } from '../src/types/quota-tiers.js';

// Mock boundaries: the safe HTTP client (so no real network) and the logger
// (avoids Winston open handles). Re-registered on every fresh module load.
const mockGet = jest.fn<(...args: any[]) => any>();
const mockPost = jest.fn<(...args: any[]) => any>();
const mockPut = jest.fn<(...args: any[]) => any>();
const mockDelete = jest.fn<(...args: any[]) => any>();

function registerMocks(): void {
  jest.unstable_mockModule('../src/utils/logger.js', () => ({
    createLogger: () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }),
  }));
  jest.unstable_mockModule('../src/services/http-client.js', () => ({
    createSafeClient: () => ({ get: mockGet, post: mockPost, put: mockPut, delete: mockDelete }),
  }));
}

/**
 * Load a fresh copy of quota.ts and return a client. quota.ts reads
 * `QUOTA_RESERVE_FAIL_OPEN` at MODULE LOAD time, so toggling it requires a
 * module reset + re-import (not just a per-call env change).
 */
async function loadQuotaService(opts: { reserveFailOpen?: boolean } = {}) {
  jest.resetModules();
  if (opts.reserveFailOpen) {
    process.env.QUOTA_RESERVE_FAIL_OPEN = 'true';
  } else {
    delete process.env.QUOTA_RESERVE_FAIL_OPEN;
  }
  registerMocks();
  const mod = await import('../src/services/quota.js');
  return mod.createQuotaService();
}

/** Build a fake reachable HTTP response (what createSafeClient yields). */
function httpResponse(statusCode: number, body: unknown) {
  return { statusCode, body, headers: {} };
}

const AUTH = 'Bearer test-token';

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPut.mockReset();
  mockDelete.mockReset();
});

// ---------------------------------------------------------------------------
// reserve() — the crown-jewel fail-open/fail-closed logic
// ---------------------------------------------------------------------------

describe('quota.reserve', () => {
  it('returns exceeded:true (429 path) when the service reports over-limit', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(
      httpResponse(429, {
        success: false,
        errorCode: 'QUOTA_EXCEEDED',
        details: { quota: { type: 'pipelines', limit: 5, used: 5, remaining: 0, resetAt: '2026-08-01T00:00:00Z' } },
      }),
    );

    const result = await quotaService.reserve('org1', 'pipelines', AUTH);

    expect(result.exceeded).toBe(true);
    expect(result.quota).toEqual({ type: 'pipelines', limit: 5, used: 5, remaining: 0, resetAt: '2026-08-01T00:00:00Z' });
  });

  it('returns exceeded:true even when a 429 omits the quota detail (safe default)', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(429, { success: false, errorCode: 'QUOTA_EXCEEDED' }));

    const result = await quotaService.reserve('org1', 'pipelines', AUTH);

    expect(result.exceeded).toBe(true);
    expect(result.quota).toEqual({ type: 'pipelines', limit: 0, used: 0, remaining: 0 });
  });

  it('FAILS CLOSED on an errored-but-reachable response (HTTP 500) by default', async () => {
    // Reachable-but-erroring quota service is often an OVERLOADED one; failing
    // open here would pile unmetered expensive work onto it. Default = deny.
    const quotaService = await loadQuotaService(); // QUOTA_RESERVE_FAIL_OPEN unset
    mockPost.mockResolvedValue(httpResponse(500, { success: false }));

    const result = await quotaService.reserve('org1', 'pipelines', AUTH);

    expect(result.exceeded).toBe(true);
    expect(result.quota).toEqual({ type: 'pipelines', limit: 0, used: 0, remaining: 0 });
  });

  it('FAILS OPEN on an errored response when QUOTA_RESERVE_FAIL_OPEN=true', async () => {
    const quotaService = await loadQuotaService({ reserveFailOpen: true });
    mockPost.mockResolvedValue(httpResponse(500, { success: false }));

    const result = await quotaService.reserve('org1', 'pipelines', AUTH);

    expect(result.exceeded).toBe(false);
    expect(result.quota).toEqual({ type: 'pipelines', limit: -1, used: 0, remaining: -1 });
  });

  it('FAILS OPEN on an UNREACHABLE service (network error → null response) regardless of env', async () => {
    // A confirmed outage (null from createSafeClient) is fail-open even with
    // the default fail-closed-on-error policy — it is not an overload signal.
    const quotaService = await loadQuotaService(); // fail-closed-on-error default
    mockPost.mockResolvedValue(null);

    const result = await quotaService.reserve('org1', 'pipelines', AUTH);

    expect(result.exceeded).toBe(false);
    expect(result.quota).toEqual({ type: 'pipelines', limit: -1, used: 0, remaining: -1 });
  });

  it('returns exceeded:false with the reserved quota on a 200 success', async () => {
    const quotaService = await loadQuotaService();
    const quota = { type: 'pipelines', limit: 10, used: 4, remaining: 6, resetAt: '2026-08-01T00:00:00Z' };
    mockPost.mockResolvedValue(httpResponse(200, { success: true, data: { quota } }));

    const result = await quotaService.reserve('org1', 'pipelines', AUTH, 1);

    expect(result.exceeded).toBe(false);
    expect(result.quota).toEqual(quota);
    // Reserve is an atomic check+increment on the increment endpoint.
    expect(mockPost).toHaveBeenCalledWith(
      '/quotas/org1/increment',
      { quotaType: 'pipelines', amount: 1 },
      expect.objectContaining({ headers: expect.objectContaining({ 'x-org-id': 'org1', 'Authorization': AUTH }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// check() — fail-open read path
// ---------------------------------------------------------------------------

describe('quota.check', () => {
  it('returns the service status on a 200 success (happy path)', async () => {
    const quotaService = await loadQuotaService();
    const status = { allowed: true, limit: 100, used: 10, remaining: 90, resetAt: '2026-08-01T00:00:00Z', unlimited: false };
    mockGet.mockResolvedValue(httpResponse(200, { success: true, data: { quotaType: 'apiCalls', status } }));

    const result = await quotaService.check('org1', 'apiCalls', AUTH);

    expect(result).toEqual(status);
    expect(mockGet).toHaveBeenCalledWith('/quotas/org1/apiCalls', expect.any(Object));
  });

  it('FAILS OPEN (allowed) when the service is unreachable (null response)', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(null);

    const result = await quotaService.check('org1', 'apiCalls', AUTH);

    expect(result.allowed).toBe(true);
    expect(result.unlimited).toBe(true);
    expect(result.failOpen).toBe(true);
  });

  it('FAILS OPEN (allowed) on a non-ok response (HTTP 500)', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(httpResponse(500, { success: false }));

    const result = await quotaService.check('org1', 'apiCalls', AUTH);

    expect(result.allowed).toBe(true);
    expect(result.failOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// increment() / decrement() — fire-and-forget, never throw
// ---------------------------------------------------------------------------

describe('quota.increment', () => {
  it('posts to the increment endpoint on the happy path', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(200, { success: true }));

    await expect(quotaService.increment('org1', 'apiCalls', AUTH, 2)).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenCalledWith(
      '/quotas/org1/increment',
      { quotaType: 'apiCalls', amount: 2 },
      expect.any(Object),
    );
  });

  it('does not throw when the service is unreachable (null response)', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(null);
    await expect(quotaService.increment('org1', 'apiCalls', AUTH)).resolves.toBeUndefined();
  });
});

describe('quota.decrement', () => {
  it('posts to the decrement endpoint, forwarding a resetAt snapshot when given', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(200, { success: true }));

    await expect(
      quotaService.decrement('org1', 'pipelines', AUTH, 1, '2026-08-01T00:00:00Z'),
    ).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenCalledWith(
      '/quotas/org1/decrement',
      { quotaType: 'pipelines', amount: 1, resetAtSnapshot: '2026-08-01T00:00:00Z' },
      expect.any(Object),
    );
  });

  it('never throws on rollback failure (null response)', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(null);
    await expect(quotaService.decrement('org1', 'pipelines', AUTH)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getTier() — used for build-queue partitioning; fail-open to developer
// ---------------------------------------------------------------------------

describe('quota.getTier', () => {
  it('returns the org tier on a 200 success (happy path)', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(httpResponse(200, { success: true, data: { quota: { tier: 'pro' } } }));

    const tier: QuotaTier = await quotaService.getTier('org1', AUTH);
    expect(tier).toBe('pro');
  });

  it('falls back to the default (developer) tier for an INVALID tier value', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(httpResponse(200, { success: true, data: { quota: { tier: 'megacorp' } } }));

    expect(await quotaService.getTier('org1', AUTH)).toBe('developer');
  });

  it('falls back to the default (developer) tier when the tier field is MISSING', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(httpResponse(200, { success: true, data: { quota: {} } }));

    expect(await quotaService.getTier('org1', AUTH)).toBe('developer');
  });

  it('fails open to the default tier when the service is unreachable (null response)', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(null);

    expect(await quotaService.getTier('org1', AUTH)).toBe('developer');
  });
});
