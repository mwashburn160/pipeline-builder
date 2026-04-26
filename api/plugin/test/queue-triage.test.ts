// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the /triage endpoint in routes/queue-status.
 *
 * Verifies:
 * - System admin sees failed jobs from all orgs (no filtering).
 * - Org admin sees only their own org's failed jobs (tenant isolation).
 * - Non-admin users (role=member) get 403.
 */

const queueGetJobs = jest.fn();
const dlqGetJobs = jest.fn();

jest.mock('../src/queue/plugin-build-queue', () => ({
  getQueue: () => ({ getJobs: queueGetJobs, getJobCounts: jest.fn() }),
  getDeadLetterQueue: () => ({ getJobs: dlqGetJobs, getJobCounts: jest.fn() }),
  purgeDlq: jest.fn(),
}));

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
  }),
  isSystemAdmin: jest.fn(),
  parseQueryInt: (val: unknown, def: number) => {
    const n = parseInt(String(val), 10);
    return isNaN(n) ? def : n;
  },
  sendSuccess: jest.fn((res: any, status: number, data: any) => {
    res.status(status).json({ success: true, statusCode: status, data });
  }),
  sendError: jest.fn((res: any, status: number, message: string) => {
    res.status(status).json({ success: false, statusCode: status, message });
  }),
  ErrorCode: { INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS' },
}));

jest.mock('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any) => {
    const ctx = { requestId: 'test-req', log: jest.fn() };
    await handler({ req, res, ctx, orgId: req.__orgId, userId: 'user-1' });
  },
}));

import { isSystemAdmin } from '@pipeline-builder/api-core';
import { createQueueStatusRoutes } from '../src/routes/queue-status';

function getTriageHandler() {
  const router = createQueueStatusRoutes();
  // Find the GET /triage handler by route path.
  const triageLayer = (router.stack as any[]).find(
    (l) => l.route?.path === '/triage' && l.route?.methods?.get,
  );
  if (!triageLayer) throw new Error('/triage handler not registered');
  return triageLayer.route.stack[0].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, json, status };
}

const job = (id: string, orgId: string, error = 'Docker build failed') => ({
  id,
  data: {
    pluginRecord: { name: `plugin-${id}`, orgId, imageTag: '1.0.0' },
    lastError: error,
  },
  failedReason: error,
  finishedOn: 1717000000000,
});

describe('GET /triage — auth and tenant isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queueGetJobs.mockResolvedValue([]);
    dlqGetJobs.mockResolvedValue([]);
  });

  it('rejects users without admin/owner role', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    const handler = getTriageHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'member', organizationId: 'org-a' },
      query: {},
    } as any, res);

    expect(queueGetJobs).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('system admin sees failures from ALL orgs', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    queueGetJobs.mockResolvedValue([
      job('1', 'org-a'),
      job('2', 'org-b'),
      job('3', 'system'),
    ]);
    const handler = getTriageHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'system',
      user: { role: 'admin', organizationId: 'system', organizationName: 'system' },
      query: {},
    } as any, res);

    const payload = (json.mock.calls[0]?.[0]) as { data: { totalFailed: number; groups: Array<{ pluginNames: string[] }> } };
    expect(payload.data.totalFailed).toBe(3);
    expect(payload.data.groups[0]?.pluginNames.sort()).toEqual(['plugin-1', 'plugin-2', 'plugin-3']);
  });

  it('org admin sees ONLY their own org failures (regression: cross-org leak)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    queueGetJobs.mockResolvedValue([
      job('1', 'org-a'),
      job('2', 'org-b'),
      job('3', 'org-a'),
    ]);
    dlqGetJobs.mockResolvedValue([
      job('4', 'org-c'),
      job('5', 'org-a'),
    ]);
    const handler = getTriageHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      query: {},
    } as any, res);

    const payload = (json.mock.calls[0]?.[0]) as { data: { totalFailed: number; groups: Array<{ pluginNames: string[] }> } };
    expect(payload.data.totalFailed).toBe(3);
    const allNames = payload.data.groups.flatMap((g) => g.pluginNames);
    expect(allNames.sort()).toEqual(['plugin-1', 'plugin-3', 'plugin-5']);
    expect(allNames.some((n) => n === 'plugin-2' || n === 'plugin-4')).toBe(false);
  });

  it('owner role is treated like admin', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    queueGetJobs.mockResolvedValue([job('1', 'org-a')]);
    const handler = getTriageHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'owner', organizationId: 'org-a' },
      query: {},
    } as any, res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 200,
      data: expect.objectContaining({ totalFailed: 1 }),
    }));
  });

  it('case-insensitive orgId comparison', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    queueGetJobs.mockResolvedValue([
      { id: '1', data: { pluginRecord: { name: 'p1', orgId: 'ORG-A' }, lastError: 'fail' }, failedReason: 'fail' },
    ]);
    const handler = getTriageHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      query: {},
    } as any, res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ totalFailed: 1 }),
    }));
  });

  it('jobs with missing orgId are excluded for non-system admins', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    queueGetJobs.mockResolvedValue([
      job('1', 'org-a'),
      { id: '2', data: { pluginRecord: { name: 'orphan' } }, failedReason: 'fail' },
    ]);
    const handler = getTriageHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      query: {},
    } as any, res);

    const payload = (json.mock.calls[0]?.[0]) as { data: { totalFailed: number } };
    expect(payload.data.totalFailed).toBe(1);
  });
});
