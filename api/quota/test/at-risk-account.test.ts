// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for GET /quotas/:orgId/at-risk — the ACCOUNT-SCOPED at-risk endpoint
 * that lets an org owner/admin see THEIR OWN org's at-risk quota dimensions
 * without system-admin.
 *
 * Unlike at-risk.test.ts (which stubs authorizeOrg), this suite runs the REAL
 * `authorizeOrg` middleware end-to-end so the tenancy guarantee (a non-sysadmin
 * can only read their own org — never another tenant's) is actually exercised.
 * Numbers come from the SINGLE pooled-aware `findByOrgId` read (its `quotas`
 * map already carries the root's shared cap for hierarchy orgs), so this
 * dashboard-polled route resolves the pool ONCE instead of once per dimension.
 *
 * The route also sits behind `requirePermission('quotas:read')` (after the
 * tenancy guard), so the happy-path users below carry `quotas:read` — the
 * capability every built-in Member/Admin bundle grants. The cross-org test
 * still 403s at the tenancy guard, before the read gate is reached.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const findByOrgId = jest.fn<(...args: unknown[]) => Promise<unknown>>();
// Kept as a spy so the suite can assert the route does NOT re-walk the
// hierarchy once per dimension any more.
const getQuotaStatus = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('../src/services/quota-service.js', () => ({
  quotaService: { findAll: jest.fn(), findByOrgId, getQuotaStatus },
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { quota: { atRiskCacheTtlMs: 60_000 } },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'],
  isSystemAdmin: jest.fn(),
  requireSystemAdmin: jest.fn(),
  // read-quotas uses `requireAuth as RequestHandler` (a middleware directly),
  // and this suite runs the full stack — so mock it as a pass-through mw.
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getParam: (p: any, k: string) => p[k],
  parseQueryIntClamped: (v: unknown, def: number, max: number) => {
    const raw = v === undefined ? def : parseInt(String(v), 10);
    const n = Number.isFinite(raw) ? raw : def;
    return Math.max(1, Math.min(n, max));
  },
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ success: true, statusCode: status, data })),
  sendError: jest.fn((res: any, status: number, message: string, code?: string) => res.status(status).json({ success: false, statusCode: status, message, code })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId ?? req.params?.orgId });
  },
}));

jest.unstable_mockModule('../src/helpers/quota-helpers.js', () => ({
  isValidQuotaType: (t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t),
}));

// NOTE: authorize-org.js is intentionally NOT mocked — we test the real guard.

const { isSystemAdmin } = await import('@pipeline-builder/api-core');
const { createReadQuotaRoutes } = await import('../src/routes/read-quotas.js');

// Grab the full ordered handler chain (requireAuth → authorizeOrg → withRoute
// handler) for a route so the middleware guard runs before the handler.
function getStack(path: string): Array<(req: any, res: any, next: any) => unknown> {
  const router = createReadQuotaRoutes();
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route?.methods.get);
  if (!layer) throw new Error(`no GET ${path}`);
  return layer.route.stack.map((s: any) => s.handle);
}

// Drive an Express-style middleware chain: each layer calls next() to advance.
async function runStack(handlers: Array<Function>, req: any, res: any) {
  let i = 0;
  const next = async () => {
    const h = handlers[i++];
    if (!h) return;
    await h(req, res, next);
  };
  await next();
}

function makeRes() {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

const status = (limit: number, used: number, unlimited = false) => ({
  limit,
  used,
  unlimited,
  remaining: limit === -1 ? -1 : Math.max(0, limit - used),
  resetAt: new Date('2026-12-31T00:00:00Z'),
});

const summary = (orgId: string, quotas: Record<string, unknown> = {}) => ({
  orgId,
  name: 'Acme',
  slug: 'acme',
  tier: 'team',
  quotas,
});

describe('GET /quotas/:orgId/at-risk (account-scoped)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findByOrgId.mockResolvedValue(summary('org-1'));
  });

  it('returns the caller\'s OWN org at-risk dims (same-org, no sysadmin)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    findByOrgId.mockResolvedValue(summary('org-1', {
      plugins: status(100, 95), // 95% — at-risk
      pipelines: status(10, 2), // 20% — fine
      apiCalls: status(-1, 999, true), // unlimited — skipped
    }));

    const res = makeRes();
    await runStack(getStack('/:orgId/at-risk'), {
      user: { organizationId: 'org-1', permissions: ['quotas:read'] }, params: { orgId: 'org-1' }, query: {},
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0].data;
    expect(payload.orgId).toBe('org-1');
    expect(payload.count).toBe(1);
    expect(payload.atRisk).toHaveLength(1);
    expect(payload.atRisk[0]).toMatchObject({ orgId: 'org-1', type: 'plugins', percent: 95 });
    // ONE pooled read for the whole response, scoped to the caller's own org —
    // the per-dimension `getQuotaStatus` walk is gone.
    expect(findByOrgId.mock.calls).toEqual([['org-1']]);
    expect(getQuotaStatus).not.toHaveBeenCalled();
  });

  it('rejects a non-sysadmin reading ANOTHER org (403) and never queries it', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);

    const res = makeRes();
    await runStack(getStack('/:orgId/at-risk'), {
      user: { organizationId: 'org-1' }, params: { orgId: 'org-2' }, query: {},
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    // Guard short-circuits before the handler touches the service.
    expect(getQuotaStatus).not.toHaveBeenCalled();
    expect(findByOrgId).not.toHaveBeenCalled();
  });

  it('honors a custom threshold', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    findByOrgId.mockResolvedValue(summary('org-1', {
      plugins: status(100, 55), // 55%
      pipelines: status(100, 5), // 5%
      apiCalls: status(100, 5),
    }));

    const res = makeRes();
    await runStack(getStack('/:orgId/at-risk'), {
      user: { organizationId: 'org-1', permissions: ['quotas:read'] }, params: { orgId: 'org-1' }, query: { threshold: '50' },
    }, res);

    const payload = res.json.mock.calls[0][0].data;
    expect(payload.threshold).toBe(50);
    expect(payload.atRisk.map((r: { type: string }) => r.type)).toEqual(['plugins']);
  });

  it('reports limit === 0 dims as 100% (permanently at-risk)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    findByOrgId.mockResolvedValue(summary('org-1', {
      plugins: status(0, 0), pipelines: status(100, 1), apiCalls: status(100, 1),
    }));

    const res = makeRes();
    await runStack(getStack('/:orgId/at-risk'), {
      user: { organizationId: 'org-1', permissions: ['quotas:read'] }, params: { orgId: 'org-1' }, query: {},
    }, res);

    const payload = res.json.mock.calls[0][0].data;
    expect(payload.atRisk[0]).toMatchObject({ type: 'plugins', percent: 100 });
  });

  it('still lets a sysadmin read a single org (cross-org allowed by the guard)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    findByOrgId.mockResolvedValue(summary('org-2', {
      plugins: status(100, 90), pipelines: status(100, 90), apiCalls: status(100, 90),
    }));

    const res = makeRes();
    await runStack(getStack('/:orgId/at-risk'), {
      user: { organizationId: '000000000000000000000001', permissions: ['quotas:read'] }, params: { orgId: 'org-2' }, query: {},
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0].data;
    expect(payload.orgId).toBe('org-2');
    expect(payload.atRisk.every((r: { percent: number }) => r.percent >= 80)).toBe(true);
    expect(findByOrgId.mock.calls).toEqual([['org-2']]);
  });

  it('returns an empty list when nothing is at-risk', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    findByOrgId.mockResolvedValue(summary('org-1', {
      plugins: status(100, 10), pipelines: status(100, 10), apiCalls: status(100, 10),
    }));

    const res = makeRes();
    await runStack(getStack('/:orgId/at-risk'), {
      user: { organizationId: 'org-1', permissions: ['quotas:read'] }, params: { orgId: 'org-1' }, query: {},
    }, res);

    const payload = res.json.mock.calls[0][0].data;
    expect(payload).toMatchObject({ atRisk: [], count: 0, orgId: 'org-1' });
  });
});
