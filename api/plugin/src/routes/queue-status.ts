import { ErrorCode, isSystemAdmin, parseQueryInt, sendError, sendSuccess } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';

import { getQueue } from '../queue/plugin-build-queue';

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
    const counts = await queue.getJobCounts();

    return sendSuccess(res, 200, {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
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

  return router;
}
