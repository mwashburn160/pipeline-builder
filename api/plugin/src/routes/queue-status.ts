/**
 * @module routes/queue-status
 * @description Queue status endpoint for monitoring BullMQ plugin build queue.
 *
 * GET /plugins/queue/status — returns job counts (waiting, active, completed, failed, delayed)
 */

import { ErrorCode, isSystemAdmin, sendError, sendSuccess } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';

import { getQueue } from '../queue/plugin-build-queue';

/**
 * Register queue status route.
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

  return router;
}
