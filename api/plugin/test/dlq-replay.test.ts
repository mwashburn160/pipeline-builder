// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /dlq/:jobId/replay operator endpoint to re-enqueue
 * a single dead-letter job.
 *
 * Verifies * - 403 for non-admin/owner roles.
 * - 404 when the DLQ job does not exist.
 * - System admin can replay any job (cross-org).
 * - Org admin/owner can replay only their own org's jobs (tenant isolation).
 * - Successful replay returns the new job id and removes the DLQ entry.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const dlqGetJob = jest.fn<AnyFn>();
const queueGetJobs = jest.fn<AnyFn>(async () => []);
const dlqGetJobs = jest.fn<AnyFn>(async () => []);
const dlqAdd = jest.fn<AnyFn>();
const queueAdd = jest.fn<AnyFn>();
const replayHelper = jest.fn<AnyFn>();

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
  // route uses getAllTierQueues; expose one entry for the single-tier
  // assertions to remain valid.
  getAllTierQueues: () => [{ tier: 'developer', queue: { name: 'plugin-build', add: queueAdd, getJobs: queueGetJobs, getJobCounts: jest.fn<AnyFn>() } }],
  getDeadLetterQueue: () => ({ getJob: dlqGetJob, add: dlqAdd, getJobs: dlqGetJobs, getJobCounts: jest.fn<AnyFn>() }),
  findFailedJob: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/queue/plugin-build-dlq.js', () => ({
  purgeDlq: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/queue/requeue.js', () => ({
  // replayDlqJob now takes (jobId, quotaService); the test only cares about the id.
  replayDlqJob: (id: string, _qs: unknown) => replayHelper(id),
  retryFailedJob: jest.fn<AnyFn>(),
}));

// Quota service stub required by createQueueStatusRoutes since.
const mockQuotaService = { getTier: jest.fn<AnyFn>().mockResolvedValue('developer') } as any;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: any, k: string) => p[k],
  isSystemAdmin: jest.fn<AnyFn>(),
  // The cross-org widening (`seesEveryOrg`): system org + plugin_queue:manage.
  isSystemOrgRequest: jest.fn<AnyFn>(),
  // Every caller here holds plugin_queue:manage; the system-org mock decides.
  // Other permissions come from the fixture's `capabilities`.
  userHasPermission: (req: any, perm: string) => perm === 'plugin_queue:manage'
    || (req.user?.capabilities ?? []).includes(perm),
  parseQueryInt: (val: unknown, def: number) => {
    const n = parseInt(String(val), 10);
    return isNaN(n) ? def: n;
  },
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ success: true, statusCode: status, data })),
  sendError: jest.fn((res: any, status: number, message: string) => res.status(status).json({ success: false, statusCode: status, message })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn<AnyFn>() }, orgId: req.__orgId, userId: 'u-1' });
  },
}));

const { isSystemAdmin, isSystemOrgRequest } = await import('@pipeline-builder/api-core');
const { createQueueStatusRoutes } = await import('../src/routes/queue-status.js');

function replayLayer() {
  const router = createQueueStatusRoutes(mockQuotaService);
  const layer = (router.stack as any[]).find( (l) => l.route?.path === '/dlq/:jobId/replay' && l.route?.methods?.post,
  );
  if (!layer) throw new Error('replay handler not registered');
  return layer;
}

// The actual withRoute handler is the LAST entry in the route stack (the
// leading `requireQueueAccess` gate sits before it). Behavioral
// tests drive the handler directly; the gate is exercised via runReplayStack.
function getReplayHandler() {
  const stack = replayLayer().route.stack;
  return stack[stack.length - 1].handle;
}

// Runs the full route stack (gate middleware + handler) so the RBAC gate is
// exercised end-to-end.
async function runReplayStack(req: any, res: any) {
  const stack = replayLayer().route.stack;
  // A synchronous gate calls next() without awaiting it, so join the chain.
  const run = async (i: number): Promise<void> => {
    if (i >= stack.length) return;
    let downstream: Promise<void> | undefined;
    await stack[i].handle(req, res, () => { downstream = run(i + 1); return downstream; });
    await downstream;
  };
  await run(0);
}

function makeRes() {
  const json = jest.fn<AnyFn>();
  const status = jest.fn<AnyFn>().mockReturnValue({ json });
  return { res: { status, json } as any, json };
}

describe('POST /dlq/:jobId/replay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    replayHelper.mockResolvedValue('new-job-99');
  });

  // RBAC gate (#FIX 2): the replay write is gated by requireQueueAccess (plugins:write
  // for a tenant), NOT a coarse role label. A caller lacking the capability is
  // rejected with 403 before the handler runs; a custom (non-admin) role that
  // holds plugins:write is allowed through.
  it('rejects a caller without plugins:write with 403', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    const { res, json } = makeRes();
    await runReplayStack({
      __orgId: 'org-a',
      user: { role: 'member', capabilities: [], organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(replayHelper).not.toHaveBeenCalled();
  });

  it('allows a non-admin caller holding plugins:write to replay', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    dlqGetJob.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-a', pluginRecord: { name: 'p' } } });
    const { res, json } = makeRes();
    await runReplayStack({
      __orgId: 'org-a',
      user: { role: 'member', capabilities: ['plugins:write'], organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(replayHelper).toHaveBeenCalledWith('j-1');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200 }));
  });

  it('returns 404 when DLQ job does not exist', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
    dlqGetJob.mockResolvedValue(undefined);
    const handler = getReplayHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: '000000000000000000000001',
      user: { role: 'admin', organizationId: '000000000000000000000001', organizationName: 'system' },
      params: { jobId: 'missing' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it('system admin can replay a job from a different org', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
    dlqGetJob.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-x', pluginRecord: { name: 'p' } } });
    const handler = getReplayHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: '000000000000000000000001',
      user: { role: 'admin', organizationId: '000000000000000000000001', organizationName: 'system' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(replayHelper).toHaveBeenCalledWith('j-1');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ replayed: true, newJobId: 'new-job-99' }),
    }));
  });

  it('org admin can replay their own org’s job', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    dlqGetJob.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-a', pluginRecord: { name: 'p' } } });
    const handler = getReplayHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(replayHelper).toHaveBeenCalledWith('j-1');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200 }));
  });

  // Another org's job answers 404 exactly like a missing one (sequential BullMQ
  // ids must not be probeable), and the attempt is recorded as authz.denied.
  it('org admin CANNOT replay a job from a different org (tenant isolation)', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    dlqGetJob.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-other', pluginRecord: { name: 'p' } } });
    const handler = getReplayHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(replayHelper).not.toHaveBeenCalled();
  });

  it('rejects a job with no top-level orgId for a non-system admin (the plugin record is not an owner)', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    dlqGetJob.mockResolvedValue({ id: 'j-orphan', data: { pluginRecord: { orgId: 'org-a', name: 'p' } } });
    const handler = getReplayHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      params: { jobId: 'j-orphan' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});

describe('triage cache after a replay', () => {
  it('drops the memoized /triage view, so the replayed job stops being offered', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
    replayHelper.mockResolvedValue('new-job-1');
    dlqGetJob.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-a', pluginRecord: { name: 'p' } } });
    const router = createQueueStatusRoutes(mockQuotaService);
    const handlerOf = (path: string, method: string) => {
      const layer = (router.stack as any[]).find((l) => l.route?.path === path && l.route?.methods?.[method]);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    };
    const triage = handlerOf('/triage', 'get');
    const replay = handlerOf('/dlq/:jobId/replay', 'post');
    const caller = { __orgId: '000000000000000000000001', user: { role: 'admin', organizationId: '000000000000000000000001' } };

    await triage({ ...caller, query: {} } as any, makeRes().res);
    await triage({ ...caller, query: {} } as any, makeRes().res);
    expect(dlqGetJobs).toHaveBeenCalledTimes(1); // the second read was served from the memo

    await replay({ ...caller, params: { jobId: 'j-1' } } as any, makeRes().res);
    await triage({ ...caller, query: {} } as any, makeRes().res);
    expect(dlqGetJobs).toHaveBeenCalledTimes(2);
  });
});
