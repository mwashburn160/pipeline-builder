// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the /triage endpoint in routes/queue-status.
 *
 * Verifies * - System admin sees failed jobs from all orgs (no filtering).
 * - Org admin sees only their own org's failed jobs (tenant isolation).
 * - Non-admin users (role=member) get 403.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const queueGetJobs = jest.fn<AnyFn>();
const dlqGetJobs = jest.fn<AnyFn>();

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
  // route uses getAllTierQueues; one entry is enough for the existing assertions.
  getAllTierQueues: () => [{ tier: 'developer', queue: { name: 'plugin-build', getJobs: queueGetJobs, getJobCounts: jest.fn<AnyFn>() } }],
  getDeadLetterQueue: () => ({ getJobs: dlqGetJobs, getJobCounts: jest.fn<AnyFn>() }),
  findFailedJob: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/queue/plugin-build-dlq.js', () => ({
  purgeDlq: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/queue/requeue.js', () => ({
  replayDlqJob: jest.fn<AnyFn>(),
  retryFailedJob: jest.fn<AnyFn>(),
}));

// Quota service stub required by createQueueStatusRoutes since.
const mockQuotaService = { getTier: jest.fn<AnyFn>().mockResolvedValue('developer') } as any;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemAdmin: jest.fn<AnyFn>(),
  // The cross-org widening (`seesEveryOrg`): system org + plugin_queue:manage.
  isSystemOrgRequest: jest.fn<AnyFn>(),
  // Every caller here holds plugin_queue:manage (the system-org mock decides
  // whether it widens anything); other permissions come from the fixture.
  userHasPermission: (req: any, perm: string) => perm === 'plugin_queue:manage'
    || !!req.user?.isSuperAdmin || (req.user?.permissions ?? []).includes(perm),
  getParam: (p: any, k: string) => p[k],
  parseQueryInt: (val: unknown, def: number) => {
    const n = parseInt(String(val), 10);
    return isNaN(n) ? def: n;
  },
  sendSuccess: jest.fn((res: any, status: number, data: any) => {
    res.status(status).json({ success: true, statusCode: status, data });
  }),
  sendError: jest.fn((res: any, status: number, message: string) => {
    res.status(status).json({ success: false, statusCode: status, message });
  }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: Function) => async (req: any, res: any) => {
    const ctx = { requestId: 'test-req', log: jest.fn<AnyFn>() };
    await handler({ req, res, ctx, orgId: req.__orgId, userId: 'user-1' });
  },
}));

const { isSystemAdmin, isSystemOrgRequest } = await import('@pipeline-builder/api-core');
const { createQueueStatusRoutes } = await import('../src/routes/queue-status.js');

function getTriageHandler() {
  const router = createQueueStatusRoutes(mockQuotaService);
  // Find the GET /triage handler by route path. The route now carries a
  // `requireQueueAccess` gate ahead of the withRoute
  // handler, so the terminal (tenant-isolation) handler is the LAST layer.
  const triageLayer = (router.stack as any[]).find( (l) => l.route?.path === '/triage' && l.route?.methods?.get,
  );
  if (!triageLayer) throw new Error('/triage handler not registered');
  const stack = triageLayer.route.stack;
  return stack[stack.length - 1].handle;
}

// Run the FULL /triage stack (gate middleware + handler) so the standardized
// permission gate is actually exercised.
async function runTriage(req: any, res: any) {
  const router = createQueueStatusRoutes(mockQuotaService);
  const layer = (router.stack as any[]).find((l) => l.route?.path === '/triage' && l.route?.methods?.get);
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

function makeRes() {
  const json = jest.fn<AnyFn>();
  const status = jest.fn<AnyFn>().mockReturnValue({ json });
  return { res: { status, json } as any, json, status };
}

const job = (id: string, orgId: string, error = 'Docker build failed') => ({
  id,
  data: {
    orgId,
    pluginRecord: { name: `plugin-${id}`, orgId },
    lastError: error,
  },
  failedReason: error,
  finishedOn: 1717000000000,
});

describe('GET /triage auth and tenant isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queueGetJobs.mockResolvedValue([]);
    dlqGetJobs.mockResolvedValue([]);
  });

  it('denies a caller without plugins:write at the gate', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    const { res, json } = makeRes();
    await runTriage({
      __orgId: 'org-a',
      user: { role: 'member', organizationId: 'org-a', permissions: ['plugins:read'] }, // no plugins:write
      query: {},
    } as any, res);

    expect(queueGetJobs).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('admits a member holding plugins:write through the gate', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    queueGetJobs.mockResolvedValue([job('1', 'org-a')]);
    const { res, json } = makeRes();
    await runTriage({
      __orgId: 'org-a',
      user: { role: 'member', organizationId: 'org-a', permissions: ['plugins:read', 'plugins:write'] },
      query: {},
    } as any, res);

    expect(queueGetJobs).toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 200,
      data: expect.objectContaining({ totalFailed: 1 }),
    }));
  });

  it('system admin sees failures from ALL orgs', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
    queueGetJobs.mockResolvedValue([
      job('1', 'org-a'),
      job('2', 'org-b'),
      job('3', '000000000000000000000001'),
    ]);
    const handler = getTriageHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: '000000000000000000000001',
      user: { role: 'admin', organizationId: '000000000000000000000001', organizationName: 'system' },
      query: {},
    } as any, res);

    const payload = (json.mock.calls[0]?.[0]) as { data: { totalFailed: number; groups: Array<{ pluginNames: string[] }> } };
    expect(payload.data.totalFailed).toBe(3);
    expect(payload.data.groups[0]?.pluginNames.sort()).toEqual(['plugin-1', 'plugin-2', 'plugin-3']);
  });

  it('org admin sees ONLY their own org failures (regression: cross-org leak)', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    queueGetJobs.mockResolvedValue([
      job('1', 'org-a'),
      job('2', 'org-b'),
      job('3', 'org-a'),
    ]);
    // A tenant's scan reads each DLQ state set on its own.
    dlqGetJobs.mockImplementation(async (types: string[]) => (types[0] === 'failed' ? [
      job('4', 'org-c'),
      job('5', 'org-a'),
    ] : []));
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
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
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
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    queueGetJobs.mockResolvedValue([
      { id: '1', data: { orgId: 'ORG-A', pluginRecord: { name: 'p1', orgId: 'ORG-A' }, lastError: 'fail' }, failedReason: 'fail' },
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

  it('a tenant\'s summary covers its OWN newest 200 jobs per source, not the newest 200 of every org', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    const rows = [
      ...Array.from({ length: 700 }, (_, i) => job(`x${i}`, 'org-other')),
      ...Array.from({ length: 250 }, (_, i) => job(`m${i}`, 'org-a')),
    ];
    queueGetJobs.mockImplementation(async (_t: string[], start: number, end: number) => rows.slice(start, end + 1));
    const handler = getTriageHandler();
    const { res, json } = makeRes();
    await handler({ __orgId: 'org-a', user: { role: 'admin', organizationId: 'org-a' }, query: {} } as any, res);

    const payload = (json.mock.calls[0]?.[0]) as { data: { totalFailed: number } };
    // Previously the newest 200 rows were ALL another org's, so this read 0.
    expect(payload.data.totalFailed).toBe(200);
  });

  it('jobs with missing orgId are excluded for non-system admins', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
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
