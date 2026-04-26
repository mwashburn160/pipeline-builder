// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for GET /quotas/at-risk — operator endpoint that returns orgs above
 * a usage threshold on any quota. Used to power "orgs about to hit limits"
 * dashboards and alerting crons.
 */

const findAll = jest.fn();

jest.mock('../src/services/quota-service', () => ({
  quotaService: { findAll, findByOrgId: jest.fn(), getQuotaStatus: jest.fn() },
}));

jest.mock('@pipeline-builder/api-core', () => ({
  ErrorCode: { INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS', VALIDATION_ERROR: 'VALIDATION_ERROR' },
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'],
  isSystemAdmin: jest.fn(),
  requireAuth: () => (_req: any, _res: any, next: any) => next(),
  getParam: (p: any, k: string) => p[k],
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ success: true, statusCode: status, data })),
  sendError: jest.fn((res: any, status: number, message: string) => res.status(status).json({ success: false, statusCode: status, message })),
}));

jest.mock('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId ?? 'system' });
  },
}));

jest.mock('../src/middleware/authorize-org', () => ({
  authorizeOrg: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../src/helpers/quota-helpers', () => ({
  AUTH_OPTS: {},
  isValidQuotaType: (t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t),
}));

import { isSystemAdmin } from '@pipeline-builder/api-core';
import router from '../src/routes/read-quotas';

function getHandler(path: string) {
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
  orgId, name, slug: name.toLowerCase(), tier: 'developer',
  quotas: Object.fromEntries(
    Object.entries(quotas).map(([k, v]) => [k, { ...v, remaining: v.limit - v.used, unlimited: v.unlimited ?? false, resetAt: '2026-12-31T00:00:00Z' }]),
  ),
});

describe('GET /quotas/at-risk', () => {
  const handler = getHandler('/at-risk');

  beforeEach(() => {
    jest.clearAllMocks();
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
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
      org('org-low', 'Low', { plugins: { used: 5, limit: 100 } }),                  // 5%
      org('org-high', 'High', { plugins: { used: 95, limit: 100 } }),               // 95%
      org('org-mid', 'Mid', { plugins: { used: 81, limit: 100 } }),                 // 81%
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
        plugins: { used: 90, limit: 100 },     // 90%
        pipelines: { used: 100, limit: 100 },  // 100%
        apiCalls: { used: 5, limit: 100 },     // 5% — below threshold
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
    expect(res.json.mock.calls[0][0].data).toEqual({ atRisk: [], count: 0, threshold: 80 });
  });
});
