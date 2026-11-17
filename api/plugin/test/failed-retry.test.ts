// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /failed/:jobId/retry — operator endpoint to re-enqueue a
 * single FAILED build from the per-tier failed set (distinct from the DLQ).
 *
 * Verifies:
 * - 403 for non-admin/owner roles.
 * - 404 when no failed job with that id exists.
 * - System admin can retry any job (cross-org).
 * - Org admin/owner can retry only their own org's jobs (tenant isolation).
 * - Successful retry returns the new job id.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const findFailed = jest.fn<AnyFn>();
const retryHelper = jest.fn<AnyFn>();
/** The retrier each retry was run as. */
const retriers: unknown[] = [];
/** The job object each retry was handed. */
const retriedJobs: unknown[] = [];

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
  getAllTierQueues: () => [{ tier: 'developer', queue: { name: 'plugin-build', add: jest.fn<AnyFn>(), getJobs: jest.fn<AnyFn>(), getJobCounts: jest.fn<AnyFn>() } }],
  getDeadLetterQueue: () => ({ getJob: jest.fn<AnyFn>(), add: jest.fn<AnyFn>(), getJobs: jest.fn<AnyFn>(), getJobCounts: jest.fn<AnyFn>() }),
  // findFailedJobs(jobId, { belongsTo?, tier? }) → every matching failed job,
  // honoring the org scope and tier the route passes (the real one skips
  // non-matching jobs across tiers). `findFailed` answers one job (held by the
  // developer queue) or an explicit list of `{ tier, job }` matches.
  findFailedJobs: async (id: string, opts: { belongsTo?: (d: unknown) => boolean; tier?: string } = {}) => {
    const found = await findFailed(id);
    const all: Array<{ tier: string; job: any }> = Array.isArray(found) ? found : found ? [{ tier: 'developer', job: found }] : [];
    return all.filter((m) => (!opts.tier || m.tier === opts.tier) && (!opts.belongsTo || opts.belongsTo(m.job.data)));
  },
}));
jest.unstable_mockModule('../src/queue/plugin-build-dlq.js', () => ({
  purgeDlq: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/queue/requeue.js', () => ({
  replayDlqJob: jest.fn<AnyFn>(),
  // retryFailedJob(job, quotaService, retrier) — handed the EXACT job the
  // ownership check found; the test records its id and the job itself.
  retryFailedJob: (job: { id: string }, _qs: unknown, retrier: unknown) => { retriers.push(retrier); retriedJobs.push(job); return retryHelper(job.id); },
}));

// Quota service stub — required by createQueueStatusRoutes.
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
    return isNaN(n) ? def : n;
  },
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ success: true, statusCode: status, data })),
  sendError: jest.fn((res: any, status: number, message: string) => res.status(status).json({ success: false, statusCode: status, message })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn<AnyFn>() }, orgId: req.__orgId, userId: 'u-1' });
  },
}));

const { isSystemAdmin, isSystemOrgRequest, sendError } = await import('@pipeline-builder/api-core');
const { createQueueStatusRoutes } = await import('../src/routes/queue-status.js');

function retryLayer() {
  const router = createQueueStatusRoutes(mockQuotaService);
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/failed/:jobId/retry' && l.route?.methods?.post,
  );
  if (!layer) throw new Error('retry handler not registered');
  return layer;
}

// The actual withRoute handler is the LAST entry in the route stack (the
// leading `requireQueueAccess` gate sits before it). Behavioral
// tests drive the handler directly; the gate is exercised via runRetryStack.
function getRetryHandler() {
  const stack = retryLayer().route.stack;
  return stack[stack.length - 1].handle;
}

// Runs the full route stack (gate middleware + handler) so the RBAC gate is
// exercised end-to-end.
async function runRetryStack(req: any, res: any) {
  const stack = retryLayer().route.stack;
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

describe('POST /failed/:jobId/retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    retryHelper.mockResolvedValue('new-job-77');
  });

  // RBAC gate (#FIX 2): the retry write is gated by requireQueueAccess (plugins:write
  // for a tenant), NOT a coarse role label. A caller lacking the capability is
  // rejected with 403 before the handler runs; a custom (non-admin) role that
  // holds plugins:write is allowed through.
  it('rejects a caller without plugins:write with 403', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    const { res, json } = makeRes();
    await runRetryStack({
      __orgId: 'org-a',
      user: { role: 'member', capabilities: [], organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(findFailed).not.toHaveBeenCalled();
    expect(retryHelper).not.toHaveBeenCalled();
  });

  it('allows a non-admin caller holding plugins:write to retry', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    findFailed.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-a', pluginRecord: { name: 'p' } } });
    const { res, json } = makeRes();
    await runRetryStack({
      __orgId: 'org-a',
      user: { role: 'member', capabilities: ['plugins:write'], organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(retryHelper).toHaveBeenCalledWith('j-1');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200 }));
  });

  it('returns 404 when no failed job with that id exists', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
    findFailed.mockResolvedValue(null);
    const handler = getRetryHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: '000000000000000000000001',
      user: { role: 'admin', organizationId: '000000000000000000000001', organizationName: 'system' },
      params: { jobId: 'missing' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(retryHelper).not.toHaveBeenCalled();
  });

  it('system admin can retry a job from a different org', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
    findFailed.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-x', pluginRecord: { name: 'p' } } });
    const handler = getRetryHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: '000000000000000000000001',
      user: { role: 'admin', organizationId: '000000000000000000000001', organizationName: 'system' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(retryHelper).toHaveBeenCalledWith('j-1');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ retried: true, newJobId: 'new-job-77' }),
    }));
  });

  it('re-runs as the RETRYING caller, re-checking plugins:publish', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    findFailed.mockResolvedValue({ id: 'j-9', data: { orgId: 'org-a', pluginRecord: { name: 'p' } } });
    retriers.length = 0;
    const { res } = makeRes();
    await getRetryHandler()({ __orgId: 'org-a', user: { sub: 'u-1', organizationId: 'org-a', permissions: ['plugins:write'] }, params: { jobId: 'j-9' } } as any, res);
    expect(retriers[0]).toMatchObject({ userId: 'u-1', isSystemAdmin: false, canPublish: false, caller: { userId: 'u-1', orgId: 'org-a' } });
  });

  it('org admin can retry their own org’s job', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    findFailed.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-a', pluginRecord: { name: 'p' } } });
    const handler = getRetryHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(retryHelper).toHaveBeenCalledWith('j-1');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200 }));
  });

  // Another org's job answers 404 exactly like a missing one (sequential BullMQ
  // ids must not be probeable), and the attempt is recorded as authz.denied.
  it('org admin CANNOT retry a job from a different org (tenant isolation)', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    findFailed.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-other', pluginRecord: { name: 'p' } } });
    const handler = getRetryHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(retryHelper).not.toHaveBeenCalled();
  });

  it('retries exactly the job the ownership check found (never a re-lookup by bare id)', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    const own = { id: 'j-1', data: { orgId: 'org-a', pluginRecord: { name: 'p' } } };
    findFailed.mockResolvedValue(own);
    retriedJobs.length = 0;
    const { res, json } = makeRes();
    await getRetryHandler()({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200 }));
    expect(retriedJobs[0]).toBe(own);
  });

  it('rejects a job with no top-level orgId for a non-system admin (the plugin record is not an owner)', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
    findFailed.mockResolvedValue({ id: 'j-orphan', data: { pluginRecord: { orgId: 'org-a', name: 'p' } } });
    const handler = getRetryHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      params: { jobId: 'j-orphan' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(retryHelper).not.toHaveBeenCalled();
  });

  // Bare BullMQ ids collide across the tier queues: an id matching failed jobs
  // in several tiers is ambiguous, so the route retries nothing and makes the
  // caller qualify it with `?tier=`.
  describe('ids shared by several tier queues', () => {
    const operatorReq = (query?: Record<string, unknown>) => ({
      __orgId: '000000000000000000000001',
      user: { role: 'admin', organizationId: '000000000000000000000001', organizationName: 'system' },
      params: { jobId: '7' },
      ...(query ? { query } : {}),
    } as any);
    const devJob = { id: '7', data: { orgId: 'org-x', pluginRecord: { name: 'dev-plugin' } } };
    const proJob = { id: '7', data: { orgId: 'org-y', pluginRecord: { name: 'pro-plugin' } } };

    beforeEach(() => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
      findFailed.mockResolvedValue([{ tier: 'developer', job: devJob }, { tier: 'pro', job: proJob }]);
      retriedJobs.length = 0;
    });

    it('answers 409 AMBIGUOUS_JOB_ID naming the tiers and retries nothing', async () => {
      const { res, json } = makeRes();
      await getRetryHandler()(operatorReq(), res);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
      expect(sendError).toHaveBeenCalledWith(
        res, 409, expect.stringContaining('several tier queues (developer, pro)'), 'AMBIGUOUS_JOB_ID', { tiers: ['developer', 'pro'] },
      );
      expect(retryHelper).not.toHaveBeenCalled();
    });

    it('a tier-qualified id retries the job in that tier', async () => {
      const { res, json } = makeRes();
      await getRetryHandler()(operatorReq({ tier: 'pro' }), res);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200 }));
      expect(retriedJobs).toEqual([proJob]);
    });

    it('rejects an unknown tier with 400 before any lookup', async () => {
      const { res, json } = makeRes();
      await getRetryHandler()(operatorReq({ tier: 'platinum' }), res);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(findFailed).not.toHaveBeenCalled();
      expect(retryHelper).not.toHaveBeenCalled();
    });

    it('rejects a repeated (array) tier with 400', async () => {
      const { res, json } = makeRes();
      await getRetryHandler()(operatorReq({ tier: ['pro', 'developer'] }), res);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(retryHelper).not.toHaveBeenCalled();
    });

    it('a tier-qualified id with no failed job in that tier answers 404', async () => {
      const { res, json } = makeRes();
      await getRetryHandler()(operatorReq({ tier: 'team' }), res);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
      expect(retryHelper).not.toHaveBeenCalled();
    });

    it('a tenant whose predicate leaves one match retries it unchanged', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
      const { res, json } = makeRes();
      await getRetryHandler()({ __orgId: 'org-y', user: { role: 'admin', organizationId: 'org-y' }, params: { jobId: '7' } } as any, res);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200 }));
      expect(retriedJobs).toEqual([proJob]);
    });

    it('the ambiguity rule applies to a tenant holding the id in several tiers', async () => {
      (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
      (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
      findFailed.mockResolvedValue([
        { tier: 'developer', job: { ...devJob, data: { ...devJob.data, orgId: 'org-a' } } },
        { tier: 'pro', job: { ...proJob, data: { ...proJob.data, orgId: 'org-a' } } },
      ]);
      const { res, json } = makeRes();
      await getRetryHandler()({ __orgId: 'org-a', user: { role: 'admin', organizationId: 'org-a' }, params: { jobId: '7' } } as any, res);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
      expect(retryHelper).not.toHaveBeenCalled();
    });
  });
});
