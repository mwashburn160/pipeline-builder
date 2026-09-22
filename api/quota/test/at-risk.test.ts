// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for GET /quotas/at-risk — operator endpoint that returns orgs above
 * a usage threshold on any quota. Used to power "orgs about to hit limits"
 * dashboards and alerting crons.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// The SCAN itself (paging, pooling, percent maths) lives in
// `QuotaService.findAtRisk` and is covered by `at-risk-scan.test.ts`. What is
// left here is the route's own job: the sysadmin gate, threshold clamping, the
// per-threshold memo, and the response envelope.
const findAtRisk = jest.fn<(...args: unknown[]) => Promise<unknown>>();
// Still needed by the `/quotas/all` pagination cases at the bottom of this file.
const findAll = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('../src/services/quota-service.js', () => ({
  quotaService: { findAtRisk, findAll, findByOrgId: jest.fn(), getQuotaStatus: jest.fn() },
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { quota: { atRiskCacheTtlMs: 60_000 } },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'],
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

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId ?? '000000000000000000000001' });
  },
}));

jest.unstable_mockModule('../src/middleware/authorize-org.js', () => ({
  authorizeOrg: () => (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule('../src/helpers/quota-helpers.js', () => ({
  isValidQuotaType: (t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t),

}));

const { getRouteGates } = await import('@pipeline-builder/api-core');
const { createReadQuotaRoutes } = await import('../src/routes/read-quotas.js');

// The router owns the at-risk memoization cache (I57). Rebuild per-test so
// one test's mocked findAll() result doesn't leak through the cache to the
// next.
function getHandler(path: string) {
  const router = createReadQuotaRoutes();
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route?.methods.get);
  if (!layer) throw new Error(`no GET ${path}`);
  // The route stack contains middleware (requireAuth + requireSystemAdmin) +
  // the withRoute handler at the end.
  return layer.route.stack.at(-1).handle;
}

/** The api-core `requireSystemAdmin` layer of the route's chain, by its tag. */
function getSystemAdminGate(path: string) {
  const router = createReadQuotaRoutes();
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route?.methods.get);
  if (!layer) throw new Error(`no GET ${path}`);
  const gate = layer.route.stack
    .map((s: any) => s.handle)
    .find((h: any) => getRouteGates(h).some((g) => g.kind === 'systemAdmin'));
  if (!gate) throw new Error(`no requireSystemAdmin gate on GET ${path}`);
  return gate;
}

function makeRes() {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

/** One at-risk row as the service hands it to the route. */
const entry = (orgId: string, percent: number, type = 'plugins') => ({
  orgId,
  name: orgId,
  slug: orgId,
  tier: 'developer',
  type,
  used: percent,
  limit: 100,
  percent,
});

describe('GET /quotas/at-risk', () => {
  let handler: (req: any, res: any) => Promise<unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Fresh router → fresh at-risk cache (see getHandler note).
    handler = getHandler('/at-risk');
  });

  it('rejects non-system-admins with 403 at the requireSystemAdmin gate', () => {
    const gate = getSystemAdminGate('/at-risk');
    const res = makeRes();
    const next = jest.fn();

    gate({ query: {}, user: { organizationId: 'org-1' } } as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(findAtRisk).not.toHaveBeenCalled();
  });

  it('admits a superadmin at the requireSystemAdmin gate', () => {
    const gate = getSystemAdminGate('/at-risk');
    const res = makeRes();
    const next = jest.fn();

    gate({ query: {}, user: { isSuperAdmin: true } } as any, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('passes the scan straight through, complete and already ranked', async () => {
    findAtRisk.mockResolvedValue([entry('org-high', 95), entry('org-mid', 81)]);
    const res = makeRes();
    await handler({ query: {} } as any, res);

    const payload = res.json.mock.calls[0][0].data;
    expect(payload.count).toBe(2);
    expect(payload.total).toBe(2);
    expect(payload.threshold).toBe(80);
    // `complete` promises the caller there is no cursor to follow — the alerting
    // cron must never have to page to see an at-risk account.
    expect(payload.complete).toBe(true);
    expect(payload.atRisk.map((r: { orgId: string }) => r.orgId)).toEqual(['org-high', 'org-mid']);
  });

  it('defaults the threshold to 80 and honors an explicit one', async () => {
    findAtRisk.mockResolvedValue([]);
    await handler({ query: {} } as any, makeRes());
    expect(findAtRisk).toHaveBeenCalledWith(80, expect.any(Number));

    await handler({ query: { threshold: '50' } } as any, makeRes());
    expect(findAtRisk).toHaveBeenCalledWith(50, expect.any(Number));
  });

  it('clamps threshold to [1, 100]', async () => {
    findAtRisk.mockResolvedValue([]);
    const res = makeRes();
    await handler({ query: { threshold: '999' } } as any, res);
    expect(res.json.mock.calls[0][0].data.threshold).toBe(100);
    expect(findAtRisk).toHaveBeenCalledWith(100, expect.any(Number));

    const res2 = makeRes();
    await handler({ query: { threshold: '-5' } } as any, res2);
    expect(res2.json.mock.calls[0][0].data.threshold).toBe(1);
    expect(findAtRisk).toHaveBeenCalledWith(1, expect.any(Number));
  });

  it('returns an empty set unremarkably', async () => {
    findAtRisk.mockResolvedValue([]);
    const res = makeRes();
    await handler({ query: {} } as any, res);
    expect(res.json.mock.calls[0][0].data).toMatchObject({ atRisk: [], count: 0, threshold: 80 });
  });

  it('memoizes the complete set per threshold (repeat call served from memo; new threshold rescans)', async () => {
    findAtRisk.mockResolvedValue([entry('o', 95)]);

    await handler({ query: {} } as any, makeRes());
    await handler({ query: {} } as any, makeRes());
    expect(findAtRisk).toHaveBeenCalledTimes(1); // second call hit the 60s memo

    await handler({ query: { threshold: '50' } } as any, makeRes());
    expect(findAtRisk).toHaveBeenCalledTimes(2); // distinct threshold → fresh scan
  });
});

/**
 * GET /quotas/all — the sysadmin org listing. `limit` was always clamped but
 * `offset` was not, so `?offset=99999999999` made Mongo walk (and discard)
 * every matching document before returning an empty page.
 */
describe('GET /quotas/all pagination bounds', () => {
  let handler: (req: any, res: any) => Promise<unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    handler = getHandler('/all');
    findAll.mockResolvedValue([]);
  });

  it('clamps an absurd offset instead of passing it through to the skip', async () => {
    await handler({ query: { offset: '99999999999' } } as any, makeRes());
    // MAX_LIST_OFFSET is 100_000, and the param is 1-based.
    expect(findAll).toHaveBeenCalledWith({ limit: 100, offset: 99_999 });
  });

  it('clamps a negative offset to the first page', async () => {
    await handler({ query: { offset: '-5' } } as any, makeRes());
    expect(findAll).toHaveBeenCalledWith({ limit: 100, offset: 0 });
  });

  it('passes an ordinary offset through unchanged', async () => {
    await handler({ query: { offset: '3', limit: '25' } } as any, makeRes());
    expect(findAll).toHaveBeenCalledWith({ limit: 25, offset: 2 });
  });
});
