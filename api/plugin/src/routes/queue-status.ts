// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, isSystemAdmin, parseQueryInt, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';

import { getDeadLetterQueue, getQueue, purgeDlq } from '../queue/plugin-build-queue';

/**
 * Register queue status routes.
 *
 * Expects middleware: requireAuth, requireOrgId
 */
export function createQueueStatusRoutes(): Router {
  const router: Router = Router();

  router.get('/status', withRoute(async ({ req, res }) => {
    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Only administrators can view queue status', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const queue = getQueue();
    const dlq = getDeadLetterQueue();
    const [counts, dlqCounts] = await Promise.all([
      queue.getJobCounts(),
      dlq.getJobCounts(),
    ]);

    return sendSuccess(res, 200, {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      dlq: {
        waiting: dlqCounts.waiting ?? 0,
        active: dlqCounts.active ?? 0,
        completed: dlqCounts.completed ?? 0,
        failed: dlqCounts.failed ?? 0,
        delayed: dlqCounts.delayed ?? 0,
      },
    });
  }));

  router.get('/failed', withRoute(async ({ req, res }) => {
    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Only administrators can view queue status', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const limit = parseQueryInt(req.query.limit, 50);
    const queue = getQueue();
    const failedJobs = await queue.getJobs(['failed'], 0, limit - 1);

    const jobs = failedJobs.map((job) => ({
      id: job.id,
      name: job.name,
      pluginName: job.data?.pluginRecord?.name ?? null,
      imageTag: job.data?.pluginRecord?.imageTag ?? null,
      error: job.failedReason ?? null,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts?.attempts ?? null,
      failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    }));

    return sendSuccess(res, 200, { jobs, total: jobs.length });
  }));

  // -- DLQ endpoints --------------------------------------------------------

  router.get('/dlq', withRoute(async ({ req, res }) => {
    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Only administrators can view DLQ', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const limit = parseQueryInt(req.query.limit, 50);
    const dlq = getDeadLetterQueue();
    const allJobs = await dlq.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, limit - 1);

    const jobs = allJobs.map((job) => ({
      id: job.id,
      name: job.name,
      pluginName: job.data?.pluginRecord?.name ?? null,
      version: job.data?.pluginRecord?.version ?? null,
      imageTag: job.data?.pluginRecord?.imageTag ?? null,
      failureCategory: job.data?.failureCategory ?? null,
      lastError: job.data?.lastError ?? job.failedReason ?? null,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts?.attempts ?? null,
      createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    }));

    return sendSuccess(res, 200, { jobs, total: jobs.length });
  }));

  router.delete('/dlq', withRoute(async ({ req, res }) => {
    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Only administrators can purge DLQ', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    await purgeDlq();

    return sendSuccess(res, 200, { message: 'DLQ purged' });
  }));

  return router;
}
