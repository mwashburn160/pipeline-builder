// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for GET /quotas/at-risk — operator endpoint that returns orgs above
 * a usage threshold on any quota. Used to power "orgs about to hit limits"
 * dashboards and alerting crons.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const findAll = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('../src/services/quota-service.js', () => ({
  quotaService: { findAll, findByOrgId: jest.fn(), getQuotaStatus: jest.fn() },
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { quota: { atRiskCacheTtlMs: 60_000 } },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'],
  isSystemAdmin: jest.fn(),
  requireAuth: () => (_req: any, _res: any, next: any) => next(),
  getParam: (p: any, k: string) => p[k],
  parseQueryIntClamped: (v: unknown, def: number, max: number) => {
    const raw = v === undefined ? def : parseInt(String(v), 10);
    const n = Number.isFinite(raw) ? raw : def;
    return Math.max(1, Math.min(n, max));
  },
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ success: true, statusCode: status, data })),
  sendError: jest.fn((res: any, status: number, message: string) => res.status(status).json({ success: false, statusCode: status, message })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId ?? 'system' });
  },
}));

jest.unstable_mockModule('../src/middleware/authorize-org.js', () => ({
  authorizeOrg: () => (_req: any, _res: any, next: any) => next(),
  INTERNAL_AUTH_OPTS: {},
}));

jest.unstable_mockModule('../src/helpers/quota-helpers.js', () => ({
  isValidQuotaType: (t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t),
}));

const { isSystemAdmin } = await import('@pipeline-builder/api-core');
const { createReadQuotaRoutes } = await import('../src/routes/read-quotas.js');

// The router owns the at-risk memoization cache (I57). Rebuild per-test so
// one test's mocked findAll() result doesn't leak through the cache to the
// next.
function getHandler(path: string) {
  const router = createReadQuotaRoutes();
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route?.methods.get);
  if (!layer) throw new Error(`no GET ${path}`);
  // The route stack contains middleware (requireAuth) + the withRoute handler at the end.
  return layer.route.stack.at(-1).handle;
}

function makeRes() {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

const org = (orgId: string, name: string, quotas: Record<string, { used: number; limit: number; unlimited?: boolean }>) => ({
  orgId,
  name,
  slug: name.toLowerCase(),
  tier: 'developer',
  quotas: Object.fromEntries(
    Object.entries(quotas).map(([k, v]) => [k, { ...v, remaining: v.limit - v.used, unlimited: v.unlimited ?? false, resetAt: '2026-12-31T00:00:00Z' }]),
  ),
});

describe('GET /quotas/at-risk', () => {
  let handler: (req: any, res: any) => Promise<unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    // Fresh router → fresh at-risk cache (see getHandler note).
    handler = getHandler('/at-risk');
  });

  it('rejects non-system-admins with 403', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    const res = makeRes();
    await handler({ query: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(findAll).not.toHaveBeenCalled();
  });

  it('returns orgs above 80% by default, sorted by percent desc', async () => {
    findAll.mockResolvedValue([
      org('org-low', 'Low', { plugins: { used: 5, limit: 100 } }), // 5%
      org('org-high', 'High', { plugins: { used: 95, limit: 100 } }), // 95%
      org('org-mid', 'Mid', { plugins: { used: 81, limit: 100 } }), // 81%
    ]);
    const res = makeRes();
    await handler({ query: {} } as any, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.count).toBe(2);
    expect(payload.data.threshold).toBe(80);
    expect(payload.data.atRisk[0].orgId).toBe('org-high');
    expect(payload.data.atRisk[1].orgId).toBe('org-mid');
  });

  it('honors a custom threshold query param', async () => {
    findAll.mockResolvedValue([
      org('org-50', 'Half', { plugins: { used: 50, limit: 100 } }),
      org('org-95', 'Almost', { plugins: { used: 95, limit: 100 } }),
    ]);
    const res = makeRes();
    await handler({ query: { threshold: '50' } } as any, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.count).toBe(2);
    expect(payload.data.threshold).toBe(50);
  });

  it('clamps threshold to [1, 100]', async () => {
    findAll.mockResolvedValue([]);
    const res = makeRes();
    await handler({ query: { threshold: '999' } } as any, res);
    expect(res.json.mock.calls[0][0].data.threshold).toBe(100);

    const res2 = makeRes();
    await handler({ query: { threshold: '-5' } } as any, res2);
    expect(res2.json.mock.calls[0][0].data.threshold).toBe(1);
  });

  it('skips unlimited quotas even when used > limit', async () => {
    findAll.mockResolvedValue([
      org('org-unlim', 'Unlim', { plugins: { used: 999, limit: -1, unlimited: true } }),
    ]);
    const res = makeRes();
    await handler({ query: {} } as any, res);
    expect(res.json.mock.calls[0][0].data.atRisk).toEqual([]);
  });

  it('emits one row per (org, quotaType) when an org is at-risk on multiple types', async () => {
    findAll.mockResolvedValue([
      org('org-multi', 'Multi', {
        plugins: { used: 90, limit: 100 }, // 90%
        pipelines: { used: 100, limit: 100 }, // 100%
        apiCalls: { used: 5, limit: 100 }, // 5% — below threshold
      }),
    ]);
    const res = makeRes();
    await handler({ query: {} } as any, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.atRisk.map((r: { type: string }) => r.type).sort()).toEqual(['pipelines', 'plugins']);
  });

  it('returns empty list when nothing is at-risk', async () => {
    findAll.mockResolvedValue([
      org('org-fine', 'Fine', { plugins: { used: 10, limit: 100 } }),
    ]);
    const res = makeRes();
    await handler({ query: {} } as any, res);
    expect(res.json.mock.calls[0][0].data).toMatchObject({ atRisk: [], count: 0, threshold: 80 });
  });
});
