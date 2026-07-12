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
import { apiCoreMock } from './helpers/mock-api-core.js';

const findFailed = jest.fn();
const retryHelper = jest.fn();

jest.unstable_mockModule('../src/queue/plugin-build-queue.js', () => ({
  getAllTierQueues: () => [{ tier: 'developer', queue: { name: 'plugin-build', add: jest.fn(), getJobs: jest.fn(), getJobCounts: jest.fn() } }],
  getDeadLetterQueue: () => ({ getJob: jest.fn(), add: jest.fn(), getJobs: jest.fn(), getJobCounts: jest.fn() }),
  purgeDlq: jest.fn(),
  replayDlqJob: jest.fn(),
  // findFailedJob(jobId) → the failed job (for the tenant-isolation check).
  findFailedJob: (id: string) => findFailed(id),
  // retryFailedJob(jobId, quotaService); the test only cares about the id.
  retryFailedJob: (id: string, _qs: unknown) => retryHelper(id),
}));

// Quota service stub — required by createQueueStatusRoutes.
const mockQuotaService = { getTier: jest.fn().mockResolvedValue('developer') } as any;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: any, k: string) => p[k],
  isSystemAdmin: jest.fn(),
  parseQueryInt: (val: unknown, def: number) => {
    const n = parseInt(String(val), 10);
    return isNaN(n) ? def : n;
  },
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ success: true, statusCode: status, data })),
  sendError: jest.fn((res: any, status: number, message: string) => res.status(status).json({ success: false, statusCode: status, message })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: 'u-1' });
  },
}));

const { isSystemAdmin } = await import('@pipeline-builder/api-core');
const { createQueueStatusRoutes } = await import('../src/routes/queue-status.js');

function getRetryHandler() {
  const router = createQueueStatusRoutes(mockQuotaService);
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/failed/:jobId/retry' && l.route?.methods?.post,
  );
  if (!layer) throw new Error('retry handler not registered');
  return layer.route.stack[0].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, json };
}

describe('POST /failed/:jobId/retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    retryHelper.mockResolvedValue('new-job-77');
  });

  it('rejects non-admin/owner roles with 403', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    const handler = getRetryHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'member', organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(findFailed).not.toHaveBeenCalled();
    expect(retryHelper).not.toHaveBeenCalled();
  });

  it('returns 404 when no failed job with that id exists', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
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
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
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

  it('org admin can retry their own org’s job', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
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

  it('org admin CANNOT retry a job from a different org (tenant isolation)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    findFailed.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-other', pluginRecord: { name: 'p' } } });
    const handler = getRetryHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(retryHelper).not.toHaveBeenCalled();
  });

  it('falls back to pluginRecord.orgId for older jobs without top-level orgId', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    findFailed.mockResolvedValue({ id: 'j-old', data: { pluginRecord: { orgId: 'org-a', name: 'p' } } });
    const handler = getRetryHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      params: { jobId: 'j-old' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200 }));
  });

  it('rejects when both orgId fields are missing for non-system admin', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    findFailed.mockResolvedValue({ id: 'j-orphan', data: {} });
    const handler = getRetryHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      params: { jobId: 'j-orphan' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(retryHelper).not.toHaveBeenCalled();
  });
});
