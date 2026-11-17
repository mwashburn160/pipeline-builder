// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/queue-status.
 *
 * Mocks BullMQ Queue.getJobCounts() and verifies the route
 * returns queue metrics for admin users and rejects non-admins.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetJobCounts = jest.fn<AnyFn>();
const mockDlqGetJobCounts = jest.fn<AnyFn>();

const mockGetJobs = jest.fn<AnyFn>();
const mockDlqGetJobs = jest.fn<AnyFn>();
// route reads per-tier queues via getAllTierQueues; we expose a
// single-tier handle so the existing single-mock assertions still hold.
const mockTierQueue = { name: 'plugin-build', getJobCounts: mockGetJobCounts, getJobs: mockGetJobs };
const mockPurgeDlq = jest.fn<AnyFn>();
const mockFindFailedJob = jest.fn<AnyFn>();
const mockDlqGetJob = jest.fn<AnyFn>();
const mockRetryFailedJob = jest.fn<AnyFn>();
const mockReplayDlqJob = jest.fn<AnyFn>();
const mockRecordAuthzDenial = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/queue/connections.js', () => ({
  // EVERY export `slot-manager` reaches for, which these route suites now pull
  // in transitively. A hand-rolled factory replaces the WHOLE namespace, so an
  // omitted export makes the import graph fail to LOAD naming that symbol —
  // which is how adding one import to the module under test broke five suites
  // that never mention it.
  getBuildCfg: () => ({ orgBuildSlots: { standard: 5, flexible: 8 } }),
  getConnectionForDb: () => ({
    // No slots held: the snapshot is then an empty list, which is the honest
    // answer for a queue fixture that never acquired one.
    hgetall: async () => ({}),
    get: async () => null,
    eval: async () => 1,
    decr: async () => 0,
    hdel: async () => 0,
  }),
  getAllTierQueues: () => [{ tier: 'developer', queue: mockTierQueue }],
  getDeadLetterQueue: () => ({ getJobCounts: mockDlqGetJobCounts, getJobs: mockDlqGetJobs, getJob: mockDlqGetJob }),
  // Honors the org scope the route passes, like the real lookup (which skips a
  // non-matching job across tiers rather than answering it).
  findFailedJob: async (id: string, belongsTo?: (d: unknown) => boolean) => {
    const job = await mockFindFailedJob(id, belongsTo);
    return job && (!belongsTo || belongsTo(job.data)) ? job : null;
  },
}));
jest.unstable_mockModule('../src/queue/plugin-build-dlq.js', () => ({
  purgeDlq: mockPurgeDlq,
}));
jest.unstable_mockModule('../src/queue/requeue.js', () => ({
  replayDlqJob: mockReplayDlqJob,
  retryFailedJob: mockRetryFailedJob,
}));

const mockEmitPluginAudit = jest.fn<AnyFn>();

// Quota service stub required by createQueueStatusRoutes since
// (replay path needs it to look up the org's tier).
const mockQuotaService = { getTier: jest.fn<AnyFn>().mockResolvedValue('developer') } as any;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockEmitPluginAudit,
  recordAuthzDenial: mockRecordAuthzDenial,
  isSystemAdmin: jest.fn<AnyFn>(),
  // The cross-org widening (`seesEveryOrg`): system org + plugin_queue:manage.
  isSystemOrgRequest: jest.fn<AnyFn>(),
  // Every caller here holds plugin_queue:manage (the system-org mock decides
  // whether it widens anything); other permissions come from the fixture.
  userHasPermission: (req: any, perm: string) => perm === 'plugin_queue:manage'
    || !!req.user?.isSuperAdmin || (req.user?.permissions ?? []).includes(perm),
  sendSuccess: jest.fn((res: any, status: number, data: any) => {
    res.status(status).json({ success: true, statusCode: status, data });
  }),
  sendError: jest.fn((res: any, status: number, message: string) => {
    res.status(status).json({ success: false, statusCode: status, message });
  }),
  parseQueryInt: (val: unknown, defaultVal: number) => {
    const n = parseInt(String(val), 10);
    return Number.isFinite(n) ? n: defaultVal;
  },
  getParam: (params: Record<string, unknown>, key: string) => params[key],
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: Function) => async (req: any, res: any, _next: any) => {
    const ctx = {
      requestId: 'test-req', log: jest.fn<AnyFn>(),
    };
    (req as any).__ctx = ctx;
    // `userId` mirrors the real wrapper, which takes it from `getIdentity` —
    // i.e. the JWT `sub`, falling back to the `x-user-id` hop header.
    await handler({ req, res, ctx, orgId: req.headers['x-org-id'] || '000000000000000000000001', userId: req.user?.sub ?? 'user-1' });
  },
}));

const { isSystemAdmin, isSystemOrgRequest } = await import('@pipeline-builder/api-core');
const { createQueueStatusRoutes } = await import('../src/routes/queue-status.js');

// Minimal Express-like mocks
function createMockReqRes(user?: Record<string, unknown>) {
  const req = {
    headers: { 'x-org-id': '000000000000000000000001' },
    method: 'GET',
    path: '/status',
    originalUrl: '/plugins/queue/status',
    ...(user ? { user } : {}),
  } as any;
  const json = jest.fn<AnyFn>();
  const status = jest.fn<AnyFn>().mockReturnValue({ json });
  const res = { status, json } as any;
  return { req, res, json, status };
}

/**
 * Drive a route's FULL middleware stack (gates + handler) and resolve only once
 * the whole chain has settled. The operator-only endpoints (`GET /status`,
 * `DELETE /dlq`) carry the REAL gate chain — `requireSystemOrgPermission`, i.e.
 * requireSystemOrg + `plugin_queue:manage` + aal2 — rather than an in-handler
 * `isSystemAdmin` check, so a suite that invoked only the terminal handler would
 * bypass authorization entirely.
 *
 * Which is why the fixtures below carry four claims beyond the identity:
 * `organizationId` (the system org — `requireSystemOrg` refuses even a
 * superadmin whose ACTIVE org is a tenant), `aal: 2`, and
 * `principalType: 'user'` + `token_use: 'access'`. The last two are the ones
 * easy to miss: `isHumanPrincipal` requires BOTH, so a fixture without them is
 * refused as a machine principal — an API key or service account, which may
 * never satisfy an assurance gate — rather than for a weak session, and the
 * message says so.
 */
async function runFullRoute(path: string, method: string, req: any, res: any): Promise<void> {
  const router = createQueueStatusRoutes(mockQuotaService);
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === path && l.route?.methods?.[method.toLowerCase()],
  );
  const handles: Array<(req: any, res: any, next: () => unknown) => unknown> =
    layer.route.stack.map((s: any) => s.handle);
  // A synchronous gate calls next() without awaiting it, so the chain must be
  // joined explicitly — otherwise the assertions run before the async handler.
  const run = async (i: number): Promise<void> => {
    const handle = handles[i];
    if (!handle) return;
    let downstream: Promise<void> | undefined;
    await handle(req, res, () => { downstream = run(i + 1); return downstream; });
    await downstream;
  };
  await run(0);
}

describe('queue-status route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return job counts for admin users', async () => {
    mockGetJobCounts.mockResolvedValue({
      waiting: 3, active: 1, completed: 10, failed: 2, delayed: 0,
    });
    mockDlqGetJobCounts.mockResolvedValue({
      waiting: 1, active: 0, completed: 0, failed: 1, delayed: 0,
    });

    const { req, res, json } = createMockReqRes({
      sub: 'admin-1',
      isSuperAdmin: true,
      organizationId: '000000000000000000000001',
      aal: 2,
      principalType: 'user',
      token_use: 'access',
    });
    await runFullRoute('/status', 'GET', req, res);

    expect(mockGetJobCounts).toHaveBeenCalled();
    expect(mockDlqGetJobCounts).toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      statusCode: 200,
      data: expect.objectContaining({
        waiting: 3,
        active: 1,
        completed: 10,
        failed: 2,
        delayed: 0,
        dlq: { waiting: 1, active: 0, completed: 0, failed: 1, delayed: 0 },
      }),
    }));
  });

  it('should reject non-admin users with 403', async () => {
    // Denied at the `requireSystemAdmin` gate, before the queue read.
    const { req, res, json } = createMockReqRes({ sub: 'user-1', role: 'admin' });
    await runFullRoute('/status', 'GET', req, res);

    expect(mockGetJobCounts).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 403,
    }));
  });

  // Tenant filtering on /failed and /dlq system admin sees all orgs'
  // jobs, org admin/owner sees only their own. Without this filter, an org
  // admin could see another tenant's plugin names + error messages.

  // The org-scoped endpoints carry a `requireQueueAccess` gate
  // middleware ahead of the withRoute handler, so the terminal handler (which
  // holds the tenant-isolation logic) is the LAST layer in the route stack.
  function getRouteHandler(path: string) {
    const router = createQueueStatusRoutes(mockQuotaService);
    const layer = (router.stack as any[]).find((l) => l.route?.path === path);
    const stack = layer?.route?.stack;
    return stack?.[stack.length - 1]?.handle;
  }

  function makeReq(
    role: 'admin' | 'owner' | 'member',
    orgId = 'org-1',
    query: Record<string, string> = {},
    permissions: string[] = ['plugins:read', 'plugins:write'],
  ) {
    return {
      headers: { 'x-org-id': orgId },
      query,
      method: 'GET',
      user: { role, organizationId: orgId, permissions },
    } as any;
  }

  describe('GET /failed tenant filter', () => {
    it('non-system admin sees only their own org\'s failed jobs', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
      mockGetJobs.mockResolvedValue([
        { id: 'j-mine', name: 'p-mine', data: { orgId: 'org-1', pluginRecord: { name: 'mine' } }, opts: {}, attemptsMade: 1 },
        { id: 'j-other', name: 'p-other', data: { orgId: 'org-OTHER', pluginRecord: { name: 'other' } }, opts: {}, attemptsMade: 1 },
        { id: 'j-orphan', name: 'p-orphan', data: { pluginRecord: { name: 'orphan' } }, opts: {}, attemptsMade: 1 }, // no orgId
      ]);

      const handler = getRouteHandler('/failed');
      const req = makeReq('admin', 'org-1');
      const json = jest.fn<AnyFn>();
      const res = { status: jest.fn<AnyFn>().mockReturnValue({ json }), json } as any;
      await handler(req, res, jest.fn<AnyFn>());

      const payload = (json.mock.calls[0] || res.status.mock.calls[0])?.[0];
      expect(payload.data.jobs.map((j: any) => j.id)).toEqual(['j-mine']);
    });

    it('system admin sees ALL orgs\' failed jobs', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
      mockGetJobCounts.mockResolvedValue({ failed: 2 });
      mockGetJobs.mockResolvedValue([
        { id: 'j-a', name: 'a', data: { orgId: 'org-1', pluginRecord: { name: 'a' } }, opts: {}, attemptsMade: 1 },
        { id: 'j-b', name: 'b', data: { orgId: 'org-2', pluginRecord: { name: 'b' } }, opts: {}, attemptsMade: 1 },
      ]);

      const handler = getRouteHandler('/failed');
      const req = makeReq('owner', '000000000000000000000001');
      const json = jest.fn<AnyFn>();
      const res = { status: jest.fn<AnyFn>().mockReturnValue({ json }), json } as any;
      await handler(req, res, jest.fn<AnyFn>());

      const payload = (json.mock.calls[0])?.[0];
      expect(payload.data.jobs.map((j: any) => j.id)).toEqual(['j-a', 'j-b']);
    });

    it('REGRESSION: the superadmin flag from a TENANT org sees only that org\'s jobs', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
      mockGetJobs.mockResolvedValue([
        { id: 'j-a', name: 'a', data: { orgId: 'org-1', pluginRecord: { name: 'a' } }, opts: {}, attemptsMade: 1 },
        { id: 'j-b', name: 'b', data: { orgId: 'org-2', pluginRecord: { name: 'b' } }, opts: {}, attemptsMade: 1 },
      ]);

      const handler = getRouteHandler('/failed');
      const req = makeReq('owner', 'org-1');
      const json = jest.fn<AnyFn>();
      const res = { status: jest.fn<AnyFn>().mockReturnValue({ json }), json } as any;
      await handler(req, res, jest.fn<AnyFn>());

      const payload = (json.mock.calls[0])?.[0];
      expect(payload.data.jobs.map((j: any) => j.id)).toEqual(['j-a']);
    });

    // Standardized gate: the org-scoped GET ops now require plugins:write
    // (matching the sibling retry/replay writes), NOT the coarse admin/owner
    // role string. A member who holds plugins:write is admitted...
    it('admits a member holding plugins:write (own-org jobs)', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
      mockGetJobs.mockResolvedValue([
        { id: 'j-mine', name: 'p', data: { orgId: 'org-1', pluginRecord: { name: 'mine' } }, opts: {}, attemptsMade: 1 },
      ]);

      const req = makeReq('member', 'org-1', {}, ['plugins:read', 'plugins:write']);
      const json = jest.fn<AnyFn>();
      const res = { status: jest.fn<AnyFn>().mockReturnValue({ json }), json } as any;
      await runFullRoute('/failed', 'GET', req, res);

      expect(mockGetJobs).toHaveBeenCalled();
      const payload = (json.mock.calls[0])?.[0];
      expect(payload.statusCode).toBe(200);
      expect(payload.data.jobs.map((j: any) => j.id)).toEqual(['j-mine']);
    });

    // ...and a non-sysadmin lacking plugins:write is denied at the gate,
    // never reaching the queue read.
    it('denies a caller without plugins:write with 403', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);

      const req = makeReq('member', 'org-1', {}, ['plugins:read']); // no plugins:write
      const json = jest.fn<AnyFn>();
      const res = { status: jest.fn<AnyFn>().mockReturnValue({ json }), json } as any;
      await runFullRoute('/failed', 'GET', req, res);

      expect(mockGetJobs).not.toHaveBeenCalled();
      const payload = (json.mock.calls[0])?.[0];
      expect(payload.statusCode).toBe(403);
    });
  });

  // I2: another org's job answered 403 while a missing one answered 404, and
  // BullMQ ids are sequential — so a tenant could probe which ids exist. Now
  // both read as 404, and the cross-org attempt reaches `authz.denied`.
  describe('retry / replay of another org\'s job', () => {
    async function post(path: string, jobId: string) {
      const handler = getRouteHandler(path);
      const json = jest.fn<AnyFn>();
      const res = { status: jest.fn<AnyFn>().mockReturnValue({ json }), json } as any;
      const req = { ...makeReq('admin', 'org-1'), method: 'POST', params: { jobId } };
      await handler(req, res, jest.fn<AnyFn>());
      return (json.mock.calls[0] as any[])[0];
    }

    beforeEach(() => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    });

    it.each([
      ['/failed/:jobId/retry', () => mockFindFailedJob, () => mockRetryFailedJob],
      ['/dlq/:jobId/replay', () => mockDlqGetJob, () => mockReplayDlqJob],
    ])('%s answers 404 (like a missing job), records the denial and re-runs nothing', async (path, lookup, rerun) => {
      const foreignJob = { id: '42', data: { orgId: 'org-other', pluginRecord: { name: 'x' } } };
      lookup().mockImplementation(async (id: string) => (id === '42' ? foreignJob : null));
      const foreign = await post(path, '42');
      const missing = await post(path, '43');
      lookup().mockReset();

      expect(foreign.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(mockRecordAuthzDenial).toHaveBeenCalledTimes(1);
      expect(mockRecordAuthzDenial).toHaveBeenCalledWith(expect.anything(), 'job-owned-by-caller-org');
      expect(rerun()).not.toHaveBeenCalled();
      expect(mockEmitPluginAudit).not.toHaveBeenCalled();
    });
  });

  describe('GET /failed + /dlq server-side paging', () => {
    const job = (id: string, finishedOn: number, orgId = 'org-1') => ({
      id, name: id, data: { orgId, pluginRecord: { name: id } }, opts: {}, attemptsMade: 1, finishedOn, timestamp: finishedOn,
    });

    async function call(path: string, req: any) {
      const handler = getRouteHandler(path);
      const json = jest.fn<AnyFn>();
      const res = { status: jest.fn<AnyFn>().mockReturnValue({ json }), json } as any;
      await handler(req, res, jest.fn<AnyFn>());
      return (json.mock.calls[0] as any[])[0].data;
    }

    it('reads offset+limit+1 rows per tier and returns the requested newest-first slice with an exact sysadmin total', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
      mockGetJobCounts.mockResolvedValue({ failed: 5 });
      mockGetJobs.mockResolvedValue([job('a', 1), job('e', 5), job('c', 3), job('b', 2), job('d', 4)]);

      const data = await call('/failed', makeReq('owner', '000000000000000000000001', { limit: '2', offset: '2' }));

      expect(mockGetJobs).toHaveBeenCalledWith(['failed'], 0, 4);
      expect(mockGetJobCounts).toHaveBeenCalledWith('failed');
      expect(data.jobs.map((j: any) => j.id)).toEqual(['c', 'b']);
      expect(data.pagination).toEqual({ total: 5, limit: 2, offset: 2, hasMore: true });
    });

    it('omits the total for a tenant-scoped caller and derives hasMore from the filtered window', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
      mockGetJobs.mockResolvedValue([job('m1', 3), job('x', 2, 'org-X'), job('m2', 1)]);

      const data = await call('/failed', makeReq('admin', 'org-1', { limit: '1', offset: '0' }));

      expect(mockGetJobCounts).not.toHaveBeenCalled();
      expect(mockGetJobs).toHaveBeenCalledWith(['failed'], 0, 499);
      expect(data.jobs.map((j: any) => j.id)).toEqual(['m1']);
      expect(data.pagination).toEqual({ limit: 1, offset: 0, hasMore: true });
    });

    /** A BullMQ-like range read over a fixed newest-first list. */
    const ranged = (rows: any[]) => async (_types: string[], start: number, end: number) => rows.slice(start, end + 1);

    it('a tenant\'s page holds its OWN newest jobs even when other orgs\' failures are newer', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
      // 1200 newer failures from another org, then three of the caller's.
      const rows = [
        ...Array.from({ length: 1200 }, (_, i) => job(`x${i}`, 10_000 - i, 'org-X')),
        job('m1', 30), job('m2', 20), job('m3', 10),
      ];
      mockGetJobs.mockImplementation(ranged(rows));

      const data = await call('/failed', makeReq('admin', 'org-1', { limit: '2', offset: '0' }));

      expect(data.jobs.map((j: any) => j.id)).toEqual(['m1', 'm2']);
      expect(data.pagination).toEqual({ limit: 2, offset: 0, hasMore: true });
      // Scanned in chunks until the matches were found, not in one unbounded read.
      expect(mockGetJobs).toHaveBeenCalledWith(['failed'], 0, 499);
      expect(mockGetJobs).toHaveBeenCalledWith(['failed'], 1000, 1499);

      const next = await call('/failed', makeReq('admin', 'org-1', { limit: '2', offset: '2' }));
      expect(next.jobs.map((j: any) => j.id)).toEqual(['m3']);
      expect(next.pagination).toEqual({ limit: 2, offset: 2, hasMore: false });
    });

    it('a tenant\'s DLQ page is scanned per state set and holds only its own newest jobs', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
      const byState: Record<string, any[]> = {
        waiting: [...Array.from({ length: 600 }, (_, i) => job(`w${i}`, 9_000 - i, 'org-X')), job('mine-w', 50)],
        delayed: [],
        active: [],
        completed: [job('mine-c', 40)],
        failed: [job('other-f', 99_999, 'org-X'), job('mine-f', 60)],
      };
      mockDlqGetJobs.mockImplementation(async (types: string[], start: number, end: number) =>
        (byState[types[0]] ?? []).slice(start, end + 1));

      const data = await call('/dlq', makeReq('admin', 'org-1', { limit: '50' }));

      expect(mockDlqGetJobCounts).not.toHaveBeenCalled();
      for (const state of Object.keys(byState)) expect(mockDlqGetJobs).toHaveBeenCalledWith([state], 0, 499);
      expect(data.jobs.map((j: any) => j.id)).toEqual(['mine-f', 'mine-w', 'mine-c']);
      expect(data.pagination).toEqual({ limit: 50, offset: 0, hasMore: false });
    });

    it('an operator keeps the cross-org view: one read of offset+limit+1 rows, other orgs included', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
      mockGetJobCounts.mockResolvedValue({ failed: 3 });
      mockGetJobs.mockImplementation(ranged([job('x1', 3, 'org-X'), job('y1', 2, 'org-Y'), job('m1', 1)]));

      const data = await call('/failed', makeReq('owner', '000000000000000000000001', { limit: '2' }));

      expect(mockGetJobs).toHaveBeenCalledTimes(1);
      expect(mockGetJobs).toHaveBeenCalledWith(['failed'], 0, 2);
      expect(data.jobs.map((j: any) => j.id)).toEqual(['x1', 'y1']);
      expect(data.pagination).toEqual({ total: 3, limit: 2, offset: 0, hasMore: true });
    });

    it('clamps limit to 200 and bounds the paging depth', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
      mockGetJobCounts.mockResolvedValue({ failed: 0 });
      mockGetJobs.mockResolvedValue([]);

      const data = await call('/failed', makeReq('owner', '000000000000000000000001', { limit: '5000', offset: '999999' }));

      expect(data.pagination.limit).toBe(200);
      expect(data.pagination.offset).toBe(4800);
      expect(mockGetJobs).toHaveBeenCalledWith(['failed'], 0, 5000);
    });

    it('pages the DLQ across its state sets with a summed sysadmin total', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
      mockDlqGetJobCounts.mockResolvedValue({ waiting: 1, delayed: 0, active: 0, completed: 1, failed: 1 });
      mockDlqGetJobs.mockResolvedValue([job('d1', 1), job('d3', 3), job('d2', 2)]);

      const data = await call('/dlq', makeReq('owner', '000000000000000000000001', { limit: '2' }));

      expect(mockDlqGetJobs).toHaveBeenCalledWith(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 2);
      expect(data.jobs.map((j: any) => j.id)).toEqual(['d3', 'd2']);
      expect(data.pagination).toEqual({ total: 3, limit: 2, offset: 0, hasMore: true });
    });
  });

  describe('GET /dlq tenant filter', () => {
    it('non-system admin sees only their own org\'s DLQ jobs', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
      // A tenant's scan reads each DLQ state set on its own.
      mockDlqGetJobs.mockImplementation(async (types: string[]) => (types[0] !== 'failed' ? [] : [
        { id: 'd-mine', name: 'mine', data: { orgId: 'org-1', pluginRecord: { name: 'mine' } }, opts: {}, attemptsMade: 1, timestamp: 0, finishedOn: 0 },
        { id: 'd-other', name: 'other', data: { orgId: 'org-X', pluginRecord: { name: 'other' } }, opts: {}, attemptsMade: 1, timestamp: 0, finishedOn: 0 },
      ]));

      const handler = getRouteHandler('/dlq');
      const req = makeReq('admin', 'org-1');
      const json = jest.fn<AnyFn>();
      const res = { status: jest.fn<AnyFn>().mockReturnValue({ json }), json } as any;
      await handler(req, res, jest.fn<AnyFn>());

      const payload = (json.mock.calls[0])?.[0];
      expect(payload.data.jobs.map((j: any) => j.id)).toEqual(['d-mine']);
    });
  });

  // The Builds page is gated on plugin_queue:manage, and the Platform Operator
  // role carries that but not plugins:write — so these routes must admit a
  // system-org queue operator on its own permission, or every button 403s.
  describe('system-org queue operator access (plugin_queue:manage, no plugins:write)', () => {
    const operator = (method: string, extra: Record<string, unknown> = {}) => ({
      headers: { 'x-org-id': '000000000000000000000001' },
      query: {},
      method,
      originalUrl: '/plugins/queue/x',
      user: {
        sub: 'op-1',
        role: 'member',
        organizationId: '000000000000000000000001',
        permissions: ['plugin_queue:manage'],
        aal: 2,
        principalType: 'user',
        token_use: 'access',
        ...extra,
      },
    } as any);

    beforeEach(() => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
    });

    function resFor() {
      const json = jest.fn<AnyFn>();
      return { json, res: { status: jest.fn<AnyFn>().mockReturnValue({ json }), json } as any };
    }

    it.each(['/failed', '/dlq', '/triage'])('GET %s answers 200 with every org\'s jobs', async (path) => {
      mockGetJobCounts.mockResolvedValue({ failed: 1 });
      mockDlqGetJobCounts.mockResolvedValue({ failed: 1 });
      const other = { id: 'j-other', name: 'o', data: { orgId: 'org-OTHER', pluginRecord: { name: 'other' } }, opts: {}, attemptsMade: 1 };
      mockGetJobs.mockResolvedValue([other]);
      mockDlqGetJobs.mockResolvedValue([other]);
      const { json, res } = resFor();
      await runFullRoute(path, 'GET', operator('GET'), res);

      const payload = (json.mock.calls[0] as any[])[0];
      expect(payload.statusCode).toBe(200);
      if (path === '/triage') expect(payload.data.totalFailed).toBe(2);
      else expect(payload.data.jobs.map((j: any) => j.id)).toEqual(['j-other']);
    });

    it.each([
      ['/failed/:jobId/retry', () => mockFindFailedJob, () => mockRetryFailedJob],
      ['/dlq/:jobId/replay', () => mockDlqGetJob, () => mockReplayDlqJob],
    ])('POST %s re-runs another org\'s job', async (path, lookup, rerun) => {
      lookup().mockResolvedValueOnce({ id: '42', data: { orgId: 'org-OTHER', pluginRecord: { name: 'x' } } });
      rerun().mockResolvedValueOnce('new-1');
      const { json, res } = resFor();
      await runFullRoute(path, 'POST', { ...operator('POST'), params: { jobId: '42' } }, res);

      expect((json.mock.calls[0] as any[])[0].statusCode).toBe(200);
      // The retry is handed the exact job found (a DLQ replay still takes its id).
      expect(rerun()).toHaveBeenCalledWith(
        path === '/dlq/:jobId/replay' ? '42' : expect.objectContaining({ id: '42' }),
        mockQuotaService, expect.objectContaining({ userId: 'op-1' }),
      );
      expect(mockEmitPluginAudit).toHaveBeenCalledWith(expect.objectContaining({ affectedOrgId: 'org-OTHER' }));
    });

    it('refuses the cross-org view to a single-factor operator session', async () => {
      const { json, res } = resFor();
      await runFullRoute('/failed', 'GET', operator('GET', { aal: 1 }), res);

      expect(mockGetJobs).not.toHaveBeenCalled();
      expect((json.mock.calls[0] as any[])[0]).toEqual(expect.objectContaining({ success: false }));
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('a tenant holding neither permission is refused 403 and audited', async () => {
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
      const req = { ...operator('POST', { organizationId: 'org-1', permissions: ['plugins:read'] }), params: { jobId: '42' } };
      // plugin_queue:manage is system-org-only: outside the system org it widens
      // nothing, and plugins:write is what a tenant needs.
      const { json, res } = resFor();
      await runFullRoute('/failed/:jobId/retry', 'POST', req, res);

      expect(mockFindFailedJob).toHaveBeenCalledTimes(0);
      expect(mockRecordAuthzDenial).toHaveBeenCalledWith(expect.anything(), 'plugins:write or system-org plugin_queue:manage');
      expect((json.mock.calls[0] as any[])[0].statusCode).toBe(403);
    });
  });

  describe('DELETE /dlq purge + audit', () => {
    it('sysadmin purge emits plugin.dlq.purge with the purged count', async () => {
      mockPurgeDlq.mockResolvedValue({ count: 7, jobs: [{ jobId: 'j1', orgId: 'org-a', pluginName: 'p' }] });

      // `requireSystemAdmin` reads the `isSuperAdmin` token claim directly.
      const req = { headers: { 'x-org-id': '000000000000000000000001' }, method: 'DELETE', originalUrl: '/plugins/queue/dlq', user: { role: 'owner', sub: 'admin-1', isSuperAdmin: true, organizationId: '000000000000000000000001', aal: 2, principalType: 'user', token_use: 'access' } } as any;
      const json = jest.fn<AnyFn>();
      const res = { status: jest.fn<AnyFn>().mockReturnValue({ json }), json } as any;
      await runFullRoute('/dlq', 'DELETE', req, res);

      expect(mockPurgeDlq).toHaveBeenCalledWith(mockQuotaService);
      expect(mockEmitPluginAudit).toHaveBeenCalledTimes(1);
      expect(mockEmitPluginAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'plugin.dlq.purge',
          actorId: 'admin-1',
          orgId: '000000000000000000000001',
          details: expect.objectContaining({ purgedCount: 7, jobs: [{ jobId: 'j1', orgId: 'org-a', pluginName: 'p' }] }),
        }),
      );
    });

    it('non-sysadmin is rejected 403 and does NOT purge or emit', async () => {
      const req = { headers: { 'x-org-id': 'org-1' }, method: 'DELETE', originalUrl: '/plugins/queue/dlq', user: { role: 'admin', sub: 'user-1' } } as any;
      const json = jest.fn<AnyFn>();
      const res = { status: jest.fn<AnyFn>().mockReturnValue({ json }), json } as any;
      await runFullRoute('/dlq', 'DELETE', req, res);

      expect(mockPurgeDlq).not.toHaveBeenCalled();
      expect(mockEmitPluginAudit).not.toHaveBeenCalled();
    });
  });
});
