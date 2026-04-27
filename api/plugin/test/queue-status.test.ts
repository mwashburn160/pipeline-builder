// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/queue-status.
 *
 * Mocks BullMQ Queue.getJobCounts() and verifies the route
 * returns queue metrics for admin users and rejects non-admins.
 */

const mockGetJobCounts = jest.fn();
const mockDlqGetJobCounts = jest.fn();

const mockGetJobs = jest.fn();
const mockDlqGetJobs = jest.fn();
jest.mock('../src/queue/plugin-build-queue', () => ({
  getQueue: () => ({ getJobCounts: mockGetJobCounts, getJobs: mockGetJobs }),
  getDeadLetterQueue: () => ({ getJobCounts: mockDlqGetJobCounts, getJobs: mockDlqGetJobs }),
  purgeDlq: jest.fn(),
  replayDlqJob: jest.fn(),
}));

jest.mock('@pipeline-builder/api-core/src/utils/params', () => ({
  parseQueryInt: (val: unknown, defaultVal: number) => {
    const n = parseInt(String(val), 10);
    return Number.isFinite(n) ? n : defaultVal;
  },
  getParam: (params: Record<string, unknown>, key: string) => params[key],
}));

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
  }),
  isSystemAdmin: jest.fn(),
  sendSuccess: jest.fn((res: any, status: number, data: any) => {
    res.status(status).json({ success: true, statusCode: status, data });
  }),
  sendError: jest.fn((res: any, status: number, message: string) => {
    res.status(status).json({ success: false, statusCode: status, message });
  }),
  ErrorCode: { INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS', NOT_FOUND: 'NOT_FOUND', MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD' },
  parseQueryInt: (val: unknown, defaultVal: number) => {
    const n = parseInt(String(val), 10);
    return Number.isFinite(n) ? n : defaultVal;
  },
  getParam: (params: Record<string, unknown>, key: string) => params[key],
}));

jest.mock('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any, _next: any) => {
    const ctx = {
      requestId: 'test-req', log: jest.fn(),
    };
    (req as any).__ctx = ctx;
    await handler({ req, res, ctx, orgId: req.headers['x-org-id'] || 'system', userId: 'user-1' });
  },
}));

import { isSystemAdmin } from '@pipeline-builder/api-core';
import { createQueueStatusRoutes } from '../src/routes/queue-status';

// Minimal Express-like mocks
function createMockReqRes() {
  const req = {
    headers: { 'x-org-id': 'system' },
    method: 'GET',
    path: '/status',
  } as any;
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as any;
  return { req, res, json, status };
}

describe('queue-status route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return job counts for admin users', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    mockGetJobCounts.mockResolvedValue({
      waiting: 3, active: 1, completed: 10, failed: 2, delayed: 0, paused: 0,
    });
    mockDlqGetJobCounts.mockResolvedValue({
      waiting: 1, active: 0, completed: 0, failed: 1, delayed: 0, paused: 0,
    });

    const router = createQueueStatusRoutes();
    const handler = (router.stack as any)[0].route.stack[0].handle;

    const { req, res, json } = createMockReqRes();
    await handler(req, res, jest.fn());

    expect(mockGetJobCounts).toHaveBeenCalled();
    expect(mockDlqGetJobCounts).toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      statusCode: 200,
      data: {
        waiting: 3,
        active: 1,
        completed: 10,
        failed: 2,
        delayed: 0,
        dlq: { waiting: 1, active: 0, completed: 0, failed: 1, delayed: 0 },
      },
    }));
  });

  it('should reject non-admin users with 403', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);

    const router = createQueueStatusRoutes();
    const handler = (router.stack as any)[0].route.stack[0].handle;

    const { req, res, json } = createMockReqRes();
    await handler(req, res, jest.fn());

    expect(mockGetJobCounts).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 403,
    }));
  });

  // Tenant filtering on /failed and /dlq — system admin sees all orgs'
  // jobs, org admin/owner sees only their own. Without this filter, an org
  // admin could see another tenant's plugin names + error messages.

  function getRouteHandler(path: string) {
    const router = createQueueStatusRoutes();
    const layer = (router.stack as any[]).find((l) => l.route?.path === path);
    return layer?.route?.stack[0]?.handle;
  }

  function makeReq(role: 'admin' | 'owner' | 'member', orgId = 'org-1', query: Record<string, string> = {}) {
    return {
      headers: { 'x-org-id': orgId },
      query,
      method: 'GET',
      user: { role, organizationId: orgId },
    } as any;
  }

  describe('GET /failed — tenant filter', () => {
    it('non-system admin sees only their own org\'s failed jobs', async () => {
      (isSystemAdmin as jest.Mock).mockReturnValue(false);
      mockGetJobs.mockResolvedValue([
        { id: 'j-mine', name: 'p-mine', data: { orgId: 'org-1', pluginRecord: { name: 'mine', imageTag: 't1' } }, opts: {}, attemptsMade: 1 },
        { id: 'j-other', name: 'p-other', data: { orgId: 'org-OTHER', pluginRecord: { name: 'other', imageTag: 't2' } }, opts: {}, attemptsMade: 1 },
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
      mockGetJobs.mockResolvedValue([
        { id: 'j-a', name: 'a', data: { orgId: 'org-1', pluginRecord: { name: 'a' } }, opts: {}, attemptsMade: 1 },
        { id: 'j-b', name: 'b', data: { orgId: 'org-2', pluginRecord: { name: 'b' } }, opts: {}, attemptsMade: 1 },
      ]);

      const handler = getRouteHandler('/failed');
      const req = makeReq('owner', 'system');
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }), json } as any;
      await handler(req, res, jest.fn());

      const payload = (json.mock.calls[0])?.[0];
      expect(payload.data.jobs.map((j: any) => j.id)).toEqual(['j-a', 'j-b']);
    });

    it('rejects member role with 403', async () => {
      (isSystemAdmin as jest.Mock).mockReturnValue(false);
      const handler = getRouteHandler('/failed');
      const req = makeReq('member' as any, 'org-1');
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }), json } as any;
      await handler(req, res, jest.fn());

      expect(mockGetJobs).not.toHaveBeenCalled();
      const payload = (json.mock.calls[0])?.[0];
      expect(payload.statusCode).toBe(403);
    });
  });

  describe('GET /dlq — tenant filter', () => {
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
});
