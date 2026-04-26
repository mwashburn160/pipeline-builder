// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, getParam, isSystemAdmin, parseQueryInt, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';

import { getDeadLetterQueue, getQueue, purgeDlq, replayDlqJob } from '../queue/plugin-build-queue';

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

  /**
   * POST /dlq/:jobId/replay — re-enqueue a single DLQ job onto the main build queue.
   *
   * Visibility:
   * - System admins: can replay any job.
   * - Org admins/owners: can replay jobs that belong to their own org.
   * - All other users: 403.
   *
   * Returns 404 if the DLQ job no longer exists. The replay carries fresh retry
   * counters; the original DLQ entry is removed on success.
   */
  router.post('/dlq/:jobId/replay', withRoute(async ({ req, res, ctx, orgId }) => {
    const role = req.user?.role;
    if (role !== 'admin' && role !== 'owner') {
      return sendError(res, 403, 'Only administrators can replay DLQ jobs', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const jobId = getParam(req.params, 'jobId');
    if (!jobId) return sendError(res, 400, 'Job ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    // Tenant-isolation: non-system admins can only replay jobs owned by their org.
    const dlq = getDeadLetterQueue();
    const dlqJob = await dlq.getJob(jobId);
    if (!dlqJob) return sendError(res, 404, `DLQ job ${jobId} not found`, ErrorCode.NOT_FOUND);

    if (!isSystemAdmin(req)) {
      const jobOrg = (dlqJob.data?.orgId ?? (dlqJob.data?.pluginRecord as { orgId?: string } | undefined)?.orgId);
      if (typeof jobOrg !== 'string' || jobOrg.toLowerCase() !== orgId.toLowerCase()) {
        return sendError(res, 403, 'Cannot replay a job owned by a different org', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }
    }

    const newJobId = await replayDlqJob(jobId);
    if (!newJobId) return sendError(res, 404, `DLQ job ${jobId} not found`, ErrorCode.NOT_FOUND);

    ctx.log('COMPLETED', 'Replayed DLQ job', { dlqJobId: jobId, newJobId });
    return sendSuccess(res, 200, { replayed: true, dlqJobId: jobId, newJobId });
  }));

  /**
   * GET /triage — failed-build summary grouped by failure category, with
   * a few representative examples per group. Powers the triage dashboard.
   *
   * Visibility:
   * - System admins (admin/owner in the system org): see all failures across all orgs.
   * - Org admins/owners: see only failures whose `pluginRecord.orgId` matches their org.
   * - All other users: 403.
   */
  router.get('/triage', withRoute(async ({ req, res, orgId }) => {
    const role = req.user?.role;
    if (role !== 'admin' && role !== 'owner') {
      return sendError(res, 403, 'Only administrators can view triage', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const isSysAdmin = isSystemAdmin(req);
    const callerOrgId = orgId.toLowerCase();

    const sampleLimit = Math.min(parseQueryInt(req.query.samples, 5), 20);
    const [queue, dlq] = [getQueue(), getDeadLetterQueue()];
    const [failedAll, dlqAll] = await Promise.all([
      queue.getJobs(['failed'], 0, 199),
      dlq.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 199),
    ]);

    // Filter to caller's org for non-system admins (tenant isolation).
    // Falls back to pluginRecord.orgId for older jobs that predate the top-level field.
    const jobOrgId = (data: { orgId?: string; pluginRecord?: { orgId?: string } } | undefined): string | undefined =>
      data?.orgId ?? data?.pluginRecord?.orgId;
    const ownsJob = (job: { data?: { orgId?: string; pluginRecord?: { orgId?: string } } }): boolean => {
      if (isSysAdmin) return true;
      const oid = jobOrgId(job.data);
      return typeof oid === 'string' && oid.toLowerCase() === callerOrgId;
    };
    const failed = failedAll.filter(ownsJob);
    const dlqJobs = dlqAll.filter(ownsJob);

    interface Bucket {
      category: string;
      count: number;
      pluginNames: Set<string>;
      samples: Array<{
        id: string | number | undefined;
        pluginName: string | null;
        imageTag: string | null;
        error: string | null;
        failedAt: string | null;
        source: 'queue' | 'dlq';
      }>;
    }

    const buckets = new Map<string, Bucket>();
    const bucketFor = (key: string): Bucket => {
      const existing = buckets.get(key);
      if (existing) return existing;
      const fresh: Bucket = { category: key, count: 0, pluginNames: new Set(), samples: [] };
      buckets.set(key, fresh);
      return fresh;
    };

    const classify = (err: string | null): string => {
      if (!err) return 'unknown';
      const lower = err.toLowerCase();
      if (lower.includes('docker') || lower.includes('dockerfile')) return 'docker-build';
      if (lower.includes('template') || lower.includes('{{')) return 'template';
      if (lower.includes('quota') || lower.includes('rate limit')) return 'quota';
      if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
      if (lower.includes('secret') || lower.includes('unauthorized') || lower.includes('forbidden')) return 'auth-secrets';
      if (lower.includes('network') || lower.includes('econnrefused') || lower.includes('enotfound')) return 'network';
      if (lower.includes('validation') || lower.includes('invalid')) return 'validation';
      return 'other';
    };

    const ingest = (job: { id?: string | number; data?: Record<string, any>; failedReason?: string; finishedOn?: number }, source: 'queue' | 'dlq') => {
      const err = job.data?.lastError ?? job.failedReason ?? null;
      const category = job.data?.failureCategory ?? classify(err);
      const bucket = bucketFor(category);
      bucket.count++;
      const pluginName = job.data?.pluginRecord?.name ?? null;
      if (pluginName) bucket.pluginNames.add(pluginName);
      if (bucket.samples.length < sampleLimit) {
        bucket.samples.push({
          id: job.id,
          pluginName,
          imageTag: job.data?.pluginRecord?.imageTag ?? null,
          error: err,
          failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          source,
        });
      }
    };

    for (const j of failed) ingest(j as unknown as Parameters<typeof ingest>[0], 'queue');
    for (const j of dlqJobs) ingest(j as unknown as Parameters<typeof ingest>[0], 'dlq');

    const groups = Array.from(buckets.values())
      .map(b => ({
        category: b.category,
        count: b.count,
        pluginNames: Array.from(b.pluginNames).sort(),
        samples: b.samples,
      }))
      .sort((a, b) => b.count - a.count);

    return sendSuccess(res, 200, {
      totalFailed: failed.length + dlqJobs.length,
      groups,
    });
  }));

  return router;
}
