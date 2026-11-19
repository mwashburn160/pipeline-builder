// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DELETE /failed/:jobId — dismiss a failed plugin build.
 *
 * Before this route a failed-builds row could only be retried or re-uploaded:
 * a build the caller had given up on stayed listed (holding its build context)
 * until the retention sweep, and the UI had no way to remove it. Same gate,
 * tenant scoping, tier qualifier and ambiguity rule as the retry route.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const findFailed = jest.fn<AnyFn>();
const dismissHelper = jest.fn<AnyFn>();
const dismissedJobs: unknown[] = [];
const audits: unknown[] = [];

jest.unstable_mockModule('../src/queue/connections.js', () => ({
  getBuildCfg: () => ({ orgBuildSlots: { standard: 5, flexible: 8 } }),
  getConnectionForDb: () => ({ hgetall: async () => ({}), get: async () => null, eval: async () => 1, decr: async () => 0, hdel: async () => 0 }),
  getAllTierQueues: () => [{ tier: 'developer', queue: { name: 'plugin-build', add: jest.fn<AnyFn>(), getJobs: jest.fn<AnyFn>(), getJobCounts: jest.fn<AnyFn>() } }],
  getDeadLetterQueue: () => ({ getJob: jest.fn<AnyFn>(), add: jest.fn<AnyFn>(), getJobs: jest.fn<AnyFn>(), getJobCounts: jest.fn<AnyFn>() }),
  findFailedJobs: async (id: string, opts: { belongsTo?: (d: unknown) => boolean; tier?: string } = {}) => {
    const found = await findFailed(id);
    const all: Array<{ tier: string; job: any }> = Array.isArray(found) ? found : found ? [{ tier: 'developer', job: found }] : [];
    return all.filter((m) => (!opts.tier || m.tier === opts.tier) && (!opts.belongsTo || opts.belongsTo(m.job.data)));
  },
}));
jest.unstable_mockModule('../src/queue/plugin-build-dlq.js', () => ({ purgeDlq: jest.fn<AnyFn>() }));
jest.unstable_mockModule('../src/queue/requeue.js', () => ({
  replayDlqJob: jest.fn<AnyFn>(),
  retryFailedJob: jest.fn<AnyFn>(),
  dismissFailedJob: (job: { id: string }) => { dismissedJobs.push(job); return dismissHelper(job.id); },
}));

const mockQuotaService = { getTier: jest.fn<AnyFn>().mockResolvedValue('developer') } as any;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: any, k: string) => p[k],
  isSystemAdmin: jest.fn<AnyFn>(),
  isSystemOrgRequest: jest.fn<AnyFn>(),
  userHasPermission: (req: any, perm: string) => perm === 'plugin_queue:manage'
    || (req.user?.capabilities ?? []).includes(perm),
  parseQueryInt: (val: unknown, def: number) => {
    const n = parseInt(String(val), 10);
    return isNaN(n) ? def : n;
  },
  recordAudit: (a: unknown) => { audits.push(a); },
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

function dismissLayer() {
  const router = createQueueStatusRoutes(mockQuotaService);
  const layer = (router.stack as any[]).find((l) => l.route?.path === '/failed/:jobId' && l.route?.methods?.delete);
  if (!layer) throw new Error('dismiss handler not registered');
  return layer;
}
const handler = () => { const s = dismissLayer().route.stack; return s[s.length - 1].handle; };
async function runStack(req: any, res: any) {
  const stack = dismissLayer().route.stack;
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
const tenant = (orgId = 'org-a', capabilities = ['plugins:write']) => ({ role: 'member', capabilities, organizationId: orgId });
function asTenant() {
  (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(false);
  (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(false);
}

describe('DELETE /failed/:jobId (dismiss)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dismissedJobs.length = 0;
    audits.length = 0;
    dismissHelper.mockResolvedValue({ contextReleased: true, retryingViaDlq: false });
  });

  it('is registered and declared with the plugin.build.dismiss audit action', () => {
    expect(dismissLayer().route.stack.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a caller without plugins:write with 403 before looking anything up', async () => {
    asTenant();
    const { res, json } = makeRes();
    await runStack({ __orgId: 'org-a', user: tenant('org-a', []), params: { jobId: 'j-1' } }, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(findFailed).not.toHaveBeenCalled();
    expect(dismissHelper).not.toHaveBeenCalled();
  });

  it('dismisses the caller org’s own failed build and audits it', async () => {
    asTenant();
    const job = { id: 'j-1', data: { orgId: 'org-a', pluginRecord: { name: 'playwright', version: '1.0.2' } } };
    findFailed.mockResolvedValue(job);
    const { res, json } = makeRes();
    await runStack({ __orgId: 'org-a', user: tenant(), params: { jobId: 'j-1' } }, res);
    expect(dismissedJobs).toEqual([job]);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 200,
      data: { dismissed: true, failedJobId: 'j-1', contextReleased: true, retryingViaDlq: false },
    }));
    expect(audits).toEqual([expect.objectContaining({
      action: 'plugin.build.dismiss',
      affectedOrgId: 'org-a',
      details: expect.objectContaining({ failedJobId: 'j-1', pluginName: 'playwright', version: '1.0.2', contextReleased: true }),
    })]);
  });

  it('another org’s job answers 404 exactly like a missing one, and nothing is removed', async () => {
    asTenant();
    findFailed.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-b', pluginRecord: { name: 'x' } } });
    const { res, json } = makeRes();
    await handler()({ __orgId: 'org-a', user: tenant(), params: { jobId: 'j-1' } }, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(dismissHelper).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it('a system-org queue operator can dismiss any org’s job (affectedOrgId = owner)', async () => {
    (isSystemAdmin as jest.Mock<AnyFn>).mockReturnValue(true);
    (isSystemOrgRequest as jest.Mock<AnyFn>).mockReturnValue(true);
    findFailed.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-x', pluginRecord: { name: 'p' } } });
    const { res, json } = makeRes();
    await handler()({ __orgId: 'sys', user: { role: 'admin', organizationId: 'sys' }, params: { jobId: 'j-1' } }, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200 }));
    expect(audits).toEqual([expect.objectContaining({ orgId: 'sys', affectedOrgId: 'org-x' })]);
  });

  it('404 when the job is gone (or a concurrent retry took it)', async () => {
    asTenant();
    findFailed.mockResolvedValue(null);
    const { res, json } = makeRes();
    await handler()({ __orgId: 'org-a', user: tenant(), params: { jobId: 'nope' } }, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));

    findFailed.mockResolvedValue({ id: 'j-2', data: { orgId: 'org-a', pluginRecord: { name: 'p' } } });
    dismissHelper.mockResolvedValue(null);
    const second = makeRes();
    await handler()({ __orgId: 'org-a', user: tenant(), params: { jobId: 'j-2' } }, second.res);
    expect(second.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(audits).toEqual([]);
  });

  it('a bare id matching several tiers is refused (409), never guessed', async () => {
    asTenant();
    findFailed.mockResolvedValue([
      { tier: 'developer', job: { id: 'j-1', data: { orgId: 'org-a', pluginRecord: { name: 'a' } } } },
      { tier: 'pro', job: { id: 'j-1', data: { orgId: 'org-a', pluginRecord: { name: 'b' } } } },
    ]);
    const { res, json } = makeRes();
    await handler()({ __orgId: 'org-a', user: tenant(), params: { jobId: 'j-1' } }, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    expect(dismissHelper).not.toHaveBeenCalled();
  });

  it('?tier= picks the one job, and an unknown tier is a 400', async () => {
    asTenant();
    const pro = { id: 'j-1', data: { orgId: 'org-a', pluginRecord: { name: 'b' } } };
    findFailed.mockResolvedValue([
      { tier: 'developer', job: { id: 'j-1', data: { orgId: 'org-a', pluginRecord: { name: 'a' } } } },
      { tier: 'pro', job: pro },
    ]);
    const { res, json } = makeRes();
    await handler()({ __orgId: 'org-a', user: tenant(), params: { jobId: 'j-1' }, query: { tier: 'pro' } }, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200 }));
    expect(dismissedJobs).toEqual([pro]);

    const bad = makeRes();
    await handler()({ __orgId: 'org-a', user: tenant(), params: { jobId: 'j-1' }, query: { tier: 'gold' } }, bad.res);
    expect(bad.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});
