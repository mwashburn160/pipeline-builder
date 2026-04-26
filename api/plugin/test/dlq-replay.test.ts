// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /dlq/:jobId/replay — operator endpoint to re-enqueue
 * a single dead-letter job.
 *
 * Verifies:
 * - 403 for non-admin/owner roles.
 * - 404 when the DLQ job does not exist.
 * - System admin can replay any job (cross-org).
 * - Org admin/owner can replay only their own org's jobs (tenant isolation).
 * - Successful replay returns the new job id and removes the DLQ entry.
 */

const dlqGetJob = jest.fn();
const dlqAdd = jest.fn();
const queueAdd = jest.fn();
const replayHelper = jest.fn();

jest.mock('../src/queue/plugin-build-queue', () => ({
  getQueue: () => ({ add: queueAdd, getJobs: jest.fn(), getJobCounts: jest.fn() }),
  getDeadLetterQueue: () => ({ getJob: dlqGetJob, add: dlqAdd, getJobs: jest.fn(), getJobCounts: jest.fn() }),
  purgeDlq: jest.fn(),
  replayDlqJob: (id: string) => replayHelper(id),
}));

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
  getParam: (p: any, k: string) => p[k],
  isSystemAdmin: jest.fn(),
  parseQueryInt: (val: unknown, def: number) => {
    const n = parseInt(String(val), 10);
    return isNaN(n) ? def : n;
  },
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ success: true, statusCode: status, data })),
  sendError: jest.fn((res: any, status: number, message: string) => res.status(status).json({ success: false, statusCode: status, message })),
  ErrorCode: {
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    NOT_FOUND: 'NOT_FOUND',
  },
}));

jest.mock('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: 'u-1' });
  },
}));

import { isSystemAdmin } from '@pipeline-builder/api-core';
import { createQueueStatusRoutes } from '../src/routes/queue-status';

function getReplayHandler() {
  const router = createQueueStatusRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/dlq/:jobId/replay' && l.route?.methods?.post,
  );
  if (!layer) throw new Error('replay handler not registered');
  return layer.route.stack[0].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, json };
}

describe('POST /dlq/:jobId/replay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    replayHelper.mockResolvedValue('new-job-99');
  });

  it('rejects non-admin/owner roles with 403', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    const handler = getReplayHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'member', organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(replayHelper).not.toHaveBeenCalled();
  });

  it('returns 404 when DLQ job does not exist', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    dlqGetJob.mockResolvedValue(undefined);
    const handler = getReplayHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'system',
      user: { role: 'admin', organizationId: 'system', organizationName: 'system' },
      params: { jobId: 'missing' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it('system admin can replay a job from a different org', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    dlqGetJob.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-x', pluginRecord: { name: 'p' } } });
    const handler = getReplayHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'system',
      user: { role: 'admin', organizationId: 'system', organizationName: 'system' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(replayHelper).toHaveBeenCalledWith('j-1');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ replayed: true, newJobId: 'new-job-99' }),
    }));
  });

  it('org admin can replay their own org’s job', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
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

  it('org admin CANNOT replay a job from a different org (tenant isolation)', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    dlqGetJob.mockResolvedValue({ id: 'j-1', data: { orgId: 'org-other', pluginRecord: { name: 'p' } } });
    const handler = getReplayHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      params: { jobId: 'j-1' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(replayHelper).not.toHaveBeenCalled();
  });

  it('falls back to pluginRecord.orgId for older jobs without top-level orgId', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);
    dlqGetJob.mockResolvedValue({ id: 'j-old', data: { pluginRecord: { orgId: 'org-a', name: 'p' } } });
    const handler = getReplayHandler();
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
    dlqGetJob.mockResolvedValue({ id: 'j-orphan', data: {} });
    const handler = getReplayHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      user: { role: 'admin', organizationId: 'org-a' },
      params: { jobId: 'j-orphan' },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});
