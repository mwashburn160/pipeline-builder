// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/queue-status.
 *
 * Mocks BullMQ Queue.getJobCounts() and verifies the route
 * returns queue metrics for admin users and rejects non-admins.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetJobCounts = jest.fn();
const mockDlqGetJobCounts = jest.fn();

const mockGetJobs = jest.fn();
const mockDlqGetJobs = jest.fn();
// route reads per-tier queues via getAllTierQueues; we expose a
// single-tier handle so the existing single-mock assertions still hold.
const mockTierQueue = { name: 'plugin-build', getJobCounts: mockGetJobCounts, getJobs: mockGetJobs };
const mockPurgeDlq = jest.fn();
jest.unstable_mockModule('../src/queue/connections.js', () => ({
  getAllTierQueues: () => [{ tier: 'developer', queue: mockTierQueue }],
  getDeadLetterQueue: () => ({ getJobCounts: mockDlqGetJobCounts, getJobs: mockDlqGetJobs }),
  findFailedJob: jest.fn(),
}));
jest.unstable_mockModule('../src/queue/plugin-build-dlq.js', () => ({
  purgeDlq: mockPurgeDlq,
}));
jest.unstable_mockModule('../src/queue/requeue.js', () => ({
  replayDlqJob: jest.fn(),
  retryFailedJob: jest.fn(),
}));

const mockEmitPluginAudit = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitPluginAudit: mockEmitPluginAudit,
  getAuditClient: () => ({ record: jest.fn() }),
}));

// Quota service stub  required by createQueueStatusRoutes since
// (replay path needs it to look up the org's tier).
const mockQuotaService = { getTier: jest.fn().mockResolvedValue('developer') } as any;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemAdmin: jest.fn(),
  // Functional gate (the default apiCoreMock stub is a pass-through): grants a
  // superadmin implicitly, else requires one of the named permissions in
  // `req.user.permissions`. Lets us assert the standardized route gate.
  requirePermission: (...perms: string[]) => (req: any, res: any, next: () => void) => {
    const granted: string[] = req.user?.permissions ?? [];
    if (req.user?.isSuperAdmin || perms.some((p) => granted.includes(p))) return next();
    return res.status(403).json({ success: false, statusCode: 403, message: 'forbidden' });
  },
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

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any, _next: any) => {
    const ctx = {
      requestId: 'test-req', log: jest.fn(),
    };
    (req as any).__ctx = ctx;
    await handler({ req, res, ctx, orgId: req.headers['x-org-id'] || '000000000000000000000001', userId: 'user-1' });
  },
}));

const { isSystemAdmin } = await import('@pipeline-builder/api-core');
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
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as any;
  return { req, res, json, status };
}

/**
 * Drive a route's FULL middleware stack (gates + handler) and resolve only once
 * the whole chain has settled. The operator-only endpoints (`GET /status`,
 * `DELETE /dlq`) now carry the REAL `requireSystemAdmin` gate rather than an
 * in-handler `isSystemAdmin` check, so a suite that invoked only the terminal
 * handler would bypass authorization.
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
      waiting: 3, active: 1, completed: 10, failed: 2, delayed: 0, paused: 0,
    });
    mockDlqGetJobCounts.mockResolvedValue({
      waiting: 1, active: 0, completed: 0, failed: 1, delayed: 0, paused: 0,
    });

    // `requireSystemAdmin` reads the `isSuperAdmin` token claim directly.
    const { req, res, json } = createMockReqRes({ sub: 'admin-1', isSuperAdmin: true });
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

  // Tenant filtering on /failed and /dlq  system admin sees all orgs'
  // jobs, org admin/owner sees only their own. Without this filter, an org
  // admin could see another tenant's plugin names + error messages.

  // The org-scoped GET endpoints now carry a `requirePermission('plugins:write')`
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

  describe('GET /failed  tenant filter', () => {
    it('non-system admin sees only their own org\'s failed jobs', async () => {
      (isSystemAdmin as jest.Mock).mockReturnValue(false);
      mockGetJobs.mockResolvedValue([
        { id: 'j-mine', name: 'p-mine', data: { orgId: 'org-1', pluginRecord: { name: 'mine' } }, opts: {}, attemptsMade: 1 },
        { id: 'j-other', name: 'p-other', data: { orgId: 'org-OTHER', pluginRecord: { name: 'other' } }, opts: {}, attemptsMade: 1 },
        { id: 'j-orphan', name: 'p-orphan', data: { pluginRecord: { name: 'orphan' } }, opts: {}, attemptsMade: 1 }, // no orgId
      ]);

      const handler = getRouteHandler('/failed');
      const req = makeReq('admin', 'org-1');
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }), json } as any;
      await handler(req, res, jest.fn());

      const payload = (json.mock.calls[0] || res.status.mock.calls[0])?.[0];
      expect(payload.data.jobs.map((j: any) => j.id)).toEqual(['j-mine']);
    });

    it('system admin sees ALL orgs\' failed jobs', async () => {
      (isSystemAdmin as jest.Mock).mockReturnValue(true);
      mockGetJobCounts.mockResolvedValue({ failed: 2 });
      mockGetJobs.mockResolvedValue([
        { id: 'j-a', name: 'a', data: { orgId: 'org-1', pluginRecord: { name: 'a' } }, opts: {}, attemptsMade: 1 },
        { id: 'j-b', name: 'b', data: { orgId: 'org-2', pluginRecord: { name: 'b' } }, opts: {}, attemptsMade: 1 },
      ]);

      const handler = getRouteHandler('/failed');
      const req = makeReq('owner', '000000000000000000000001');
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }), json } as any;
      await handler(req, res, jest.fn());

      const payload = (json.mock.calls[0])?.[0];
      expect(payload.data.jobs.map((j: any) => j.id)).toEqual(['j-a', 'j-b']);
    });

    // Standardized gate: the org-scoped GET ops now require plugins:write
    // (matching the sibling retry/replay writes), NOT the coarse admin/owner
    // role string. A member who holds plugins:write is admitted...
    it('admits a member holding plugins:write (own-org jobs)', async () => {
      (isSystemAdmin as jest.Mock).mockReturnValue(false);
      mockGetJobs.mockResolvedValue([
        { id: 'j-mine', name: 'p', data: { orgId: 'org-1', pluginRecord: { name: 'mine' } }, opts: {}, attemptsMade: 1 },
      ]);

      const req = makeReq('member', 'org-1', {}, ['plugins:read', 'plugins:write']);
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }), json } as any;
      await runFullRoute('/failed', 'GET', req, res);

      expect(mockGetJobs).toHaveBeenCalled();
      const payload = (json.mock.calls[0])?.[0];
      expect(payload.statusCode).toBe(200);
      expect(payload.data.jobs.map((j: any) => j.id)).toEqual(['j-mine']);
    });

    // ...and a non-sysadmin lacking plugins:write is denied at the gate,
    // never reaching the queue read.
    it('denies a caller without plugins:write with 403', async () => {
      (isSystemAdmin as jest.Mock).mockReturnValue(false);

      const req = makeReq('member', 'org-1', {}, ['plugins:read']); // no plugins:write
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }), json } as any;
      await runFullRoute('/failed', 'GET', req, res);

      expect(mockGetJobs).not.toHaveBeenCalled();
      const payload = (json.mock.calls[0])?.[0];
      expect(payload.statusCode).toBe(403);
    });
  });

  describe('GET /failed + /dlq  server-side paging', () => {
    const job = (id: string, finishedOn: number, orgId = 'org-1') => ({
      id, name: id, data: { orgId, pluginRecord: { name: id } }, opts: {}, attemptsMade: 1, finishedOn, timestamp: finishedOn,
    });

    async function call(path: string, req: any) {
      const handler = getRouteHandler(path);
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }), json } as any;
      await handler(req, res, jest.fn());
      return (json.mock.calls[0] as any[])[0].data;
    }

    it('reads offset+limit+1 rows per tier and returns the requested newest-first slice with an exact sysadmin total', async () => {
      (isSystemAdmin as jest.Mock).mockReturnValue(true);
      mockGetJobCounts.mockResolvedValue({ failed: 5 });
      mockGetJobs.mockResolvedValue([job('a', 1), job('e', 5), job('c', 3), job('b', 2), job('d', 4)]);

      const data = await call('/failed', makeReq('owner', '000000000000000000000001', { limit: '2', offset: '2' }));

      expect(mockGetJobs).toHaveBeenCalledWith(['failed'], 0, 4);
      expect(mockGetJobCounts).toHaveBeenCalledWith('failed');
      expect(data.jobs.map((j: any) => j.id)).toEqual(['c', 'b']);
      expect(data.pagination).toEqual({ total: 5, limit: 2, offset: 2, hasMore: true });
    });

    it('omits the total for a tenant-scoped caller and derives hasMore from the filtered window', async () => {
      (isSystemAdmin as jest.Mock).mockReturnValue(false);
      mockGetJobs.mockResolvedValue([job('m1', 3), job('x', 2, 'org-X'), job('m2', 1)]);

      const data = await call('/failed', makeReq('admin', 'org-1', { limit: '1', offset: '0' }));

      expect(mockGetJobCounts).not.toHaveBeenCalled();
      expect(data.jobs.map((j: any) => j.id)).toEqual(['m1']);
      expect(data.pagination).toEqual({ limit: 1, offset: 0, hasMore: true });
    });

    it('clamps limit to 200 and bounds the paging depth', async () => {
      (isSystemAdmin as jest.Mock).mockReturnValue(true);
      mockGetJobCounts.mockResolvedValue({ failed: 0 });
      mockGetJobs.mockResolvedValue([]);

      const data = await call('/failed', makeReq('owner', '000000000000000000000001', { limit: '5000', offset: '999999' }));

      expect(data.pagination.limit).toBe(200);
      expect(data.pagination.offset).toBe(4800);
      expect(mockGetJobs).toHaveBeenCalledWith(['failed'], 0, 5000);
    });

    it('pages the DLQ across its state sets with a summed sysadmin total', async () => {
      (isSystemAdmin as jest.Mock).mockReturnValue(true);
      mockDlqGetJobCounts.mockResolvedValue({ waiting: 1, delayed: 0, active: 0, completed: 1, failed: 1 });
      mockDlqGetJobs.mockResolvedValue([job('d1', 1), job('d3', 3), job('d2', 2)]);

      const data = await call('/dlq', makeReq('owner', '000000000000000000000001', { limit: '2' }));

      expect(mockDlqGetJobs).toHaveBeenCalledWith(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 2);
      expect(data.jobs.map((j: any) => j.id)).toEqual(['d3', 'd2']);
      expect(data.pagination).toEqual({ total: 3, limit: 2, offset: 0, hasMore: true });
    });
  });

  describe('GET /dlq  tenant filter', () => {
    it('non-system admin sees only their own org\'s DLQ jobs', async () => {
      (isSystemAdmin as jest.Mock).mockReturnValue(false);
      mockDlqGetJobs.mockResolvedValue([
        { id: 'd-mine', name: 'mine', data: { orgId: 'org-1', pluginRecord: { name: 'mine' } }, opts: {}, attemptsMade: 1, timestamp: 0, finishedOn: 0 },
        { id: 'd-other', name: 'other', data: { orgId: 'org-X', pluginRecord: { name: 'other' } }, opts: {}, attemptsMade: 1, timestamp: 0, finishedOn: 0 },
      ]);

      const handler = getRouteHandler('/dlq');
      const req = makeReq('admin', 'org-1');
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }), json } as any;
      await handler(req, res, jest.fn());

      const payload = (json.mock.calls[0])?.[0];
      expect(payload.data.jobs.map((j: any) => j.id)).toEqual(['d-mine']);
    });
  });

  describe('DELETE /dlq  purge + audit', () => {
    it('sysadmin purge emits plugin.dlq.purge with the purged count', async () => {
      mockPurgeDlq.mockResolvedValue(7);

      // `requireSystemAdmin` reads the `isSuperAdmin` token claim directly.
      const req = { headers: { 'x-org-id': '000000000000000000000001' }, method: 'DELETE', originalUrl: '/plugins/queue/dlq', user: { role: 'owner', sub: 'admin-1', isSuperAdmin: true } } as any;
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }), json } as any;
      await runFullRoute('/dlq', 'DELETE', req, res);

      expect(mockPurgeDlq).toHaveBeenCalledWith(mockQuotaService);
      expect(mockEmitPluginAudit).toHaveBeenCalledTimes(1);
      expect(mockEmitPluginAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'plugin.dlq.purge',
          actorId: 'admin-1',
          details: expect.objectContaining({ purgedCount: 7 }),
        }),
      );
    });

    it('non-sysadmin is rejected 403 and does NOT purge or emit', async () => {
      const req = { headers: { 'x-org-id': 'org-1' }, method: 'DELETE', originalUrl: '/plugins/queue/dlq', user: { role: 'admin', sub: 'user-1' } } as any;
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }), json } as any;
      await runFullRoute('/dlq', 'DELETE', req, res);

      expect(mockPurgeDlq).not.toHaveBeenCalled();
      expect(mockEmitPluginAudit).not.toHaveBeenCalled();
    });
  });
});
