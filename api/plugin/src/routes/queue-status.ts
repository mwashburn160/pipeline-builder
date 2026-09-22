// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  ErrorCode, audited, getParam, isSystemAdmin, parsePage, parseQueryInt, requirePermission, requireSystemAdmin, sendError, sendSuccess, actorId, userHasPermission,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import type { Job } from 'bullmq';
import { Router, type Request } from 'express';

import type { PluginBuildJobData } from '../helpers/plugin-helpers.js';
import { findFailedJob, getAllTierQueues, getDeadLetterQueue } from '../queue/connections.js';
import { intFromEnv } from '../queue/env-int.js';
import { purgeDlq } from '../queue/plugin-build-dlq.js';
import { replayDlqJob, retryFailedJob, type Retrier } from '../queue/requeue.js';
import { emitPluginAudit } from '../services/audit.js';
import { callerFromRequest } from '../services/ecosystem/context.js';

/**
 * The caller re-running a build (E20): the re-run gets THEIR authority, and
 * `plugins:publish` is re-checked here, not inherited from the upload.
 */
function retrierFrom(req: Request, userId: string): Retrier {
  return {
    userId,
    isSystemAdmin: isSystemAdmin(req),
    canPublish: userHasPermission(req, 'plugins:publish'),
    caller: callerFromRequest(req),
  };
}

/** Shape returned by GET /triage — failed-build summary grouped by category. */
interface TriageSample {
  id: string | number | undefined;
  pluginName: string | null;
  version: string | null;
  error: string | null;
  failedAt: string | null;
  source: 'queue' | 'dlq';
}
interface TriageGroup {
  category: string;
  count: number;
  pluginNames: string[];
  samples: TriageSample[];
}
interface TriagePayload {
  totalFailed: number;
  groups: TriageGroup[];
}
interface TriageCacheEntry {
  expires: number;
  payload: TriagePayload;
}

/**
 * TTL (ms) for the GET /triage aggregate memo. The triage scan pulls up to
 * ~1200 job payloads (200 per tier queue × 4 tiers + 200 DLQ) and buckets them
 * in-memory on EVERY request; a short-TTL memo collapses a dashboard's repeated
 * polls into one scan without letting the summary go meaningfully stale. Mirrors
 * the read-quotas at-risk cache pattern.
 */
const TRIAGE_CACHE_TTL_MS = intFromEnv('PLUGIN_TRIAGE_CACHE_TTL_MS', 5000);

/**
 * Hard cap on distinct triage cache keys. Unlike the sysadmin-only read-quotas
 * cache, `/triage` is org-callable and keyed `all|org:<orgId>:<sampleLimit>`, so
 * the key space grows with tenant count. Expired entries are only overwritten on
 * re-access, so an org that polls once and never returns would otherwise leave a
 * stale entry forever. Sweep expired entries on write and, if still over the
 * cap, evict the oldest (Map preserves insertion order) to bound memory.
 */
const TRIAGE_CACHE_MAX_ENTRIES = intFromEnv('PLUGIN_TRIAGE_CACHE_MAX_ENTRIES', 500);

/** Drop expired entries, then evict oldest keys until at/under the cap. */
function pruneTriageCache(cache: Map<string, TriageCacheEntry>, now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expires <= now) cache.delete(key);
  }
  while (cache.size >= TRIAGE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Deepest row a caller may page to on GET /failed and GET /dlq. Each page reads
 * `offset + limit` entries from every source queue (BullMQ ranges start at the
 * head of a set), so an unbounded offset would be an unbounded Redis range read.
 */
const QUEUE_MAX_PAGE_DEPTH = intFromEnv('PLUGIN_QUEUE_MAX_PAGE_DEPTH', 5000);

/** Max rows per page on GET /failed and GET /dlq (parity with read routes). */
const QUEUE_MAX_PAGE_LIMIT = 200;

/** Parse + clamp `limit`/`offset` for the paged queue listings via the shared
 *  `parsePage` primitive. The offset ceiling is depth-aware: a page reads
 *  `offset + limit` entries from every source queue. */
const parseQueuePage = (query: Record<string, unknown>) => parsePage(query, {
  def: 50,
  max: QUEUE_MAX_PAGE_LIMIT,
  maxOffset: (limit) => QUEUE_MAX_PAGE_DEPTH - limit,
});

/** Newest-first order over a merged multi-queue read (finished, else enqueued). */
const newestFirst = (a: Job, b: Job): number =>
  ((b.finishedOn ?? b.timestamp ?? 0) - (a.finishedOn ?? a.timestamp ?? 0));

/**
 * One page of a merged, tenant-filtered job listing. `window` holds the first
 * `offset + limit + 1` rows of every source already merged newest-first, so the
 * page is a slice of a stable global order and the extra row tells us whether
 * another page exists. `total` is exact for system admins (the queue counts
 * cover every tenant); a tenant-scoped caller's total can't be known without
 * scanning every tenant's jobs, so it is omitted and `hasMore` drives paging.
 */
function pageOf<T extends Job>(
  window: T[],
  { limit, offset }: { limit: number; offset: number },
  total: number | undefined,
): { page: T[]; pagination: { total?: number; limit: number; offset: number; hasMore: boolean } } {
  const page = window.slice(offset, offset + limit);
  const hasMore = total !== undefined ? offset + page.length < total : window.length > offset + limit;
  return { page, pagination: { ...(total !== undefined ? { total } : {}), limit, offset, hasMore } };
}

/** Resolve a build job's owning org: the top-level `orgId`, falling back to the
 *  embedded `pluginRecord.orgId` for older jobs that predate the top-level field. */
const jobOrgId = (data: { orgId?: string; pluginRecord?: { orgId?: string } } | undefined): string | undefined =>
  data?.orgId ?? data?.pluginRecord?.orgId;

/** True when a job belongs to `orgId` (case-insensitive). Used for the
 *  non-system-admin tenant-isolation filter across the failed/DLQ endpoints. */
const jobBelongsToOrg = (
  data: { orgId?: string; pluginRecord?: { orgId?: string } } | undefined,
  orgId: string,
): boolean => {
  const oid = jobOrgId(data);
  return typeof oid === 'string' && oid.toLowerCase() === orgId.toLowerCase();
};

/**
 * Register queue status routes.
 *
 * Expects middleware: requireAuth, requireOrgId
 */
export function createQueueStatusRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  // Per-router memo for GET /triage so each app/test gets its own cache. Keyed by
  // visibility scope (`all` for system admins vs the caller's own org) + the
  // requested sample count, so a sysadmin's cross-org summary is never served to
  // an org-scoped caller and vice-versa.
  const triageCache = new Map<string, TriageCacheEntry>();

  // Access: `requireSystemAdmin` (route middleware) — the counts aggregate
  // across every tenant's builds, so this is an operator-only view. The gate
  // replaces the equivalent in-handler `isSystemAdmin` check so the route table
  // can see the requirement.
  router.get('/status', requireSystemAdmin, withRoute(async ({ res }) => {
    // counts aggregate across all per-tier queues so existing
    // dashboard widgets keep their meaning. Per-tier breakdown is on the
    // returned `tiers` field for operators that want it.
    const tierQueues = getAllTierQueues();
    const dlq = getDeadLetterQueue();
    const [tierCounts, dlqCounts] = await Promise.all([
      Promise.all(tierQueues.map(async ({ tier, queue }) => ({ tier, counts: await queue.getJobCounts() }))),
      dlq.getJobCounts(),
    ]);

    const sum = (key: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed') =>
      tierCounts.reduce((acc, { counts }) => acc + (counts[key] ?? 0), 0);

    return sendSuccess(res, 200, {
      waiting: sum('waiting'),
      active: sum('active'),
      completed: sum('completed'),
      failed: sum('failed'),
      delayed: sum('delayed'),
      tiers: Object.fromEntries(tierCounts.map(({ tier, counts }) => [tier, {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      }])),
      dlq: {
        waiting: dlqCounts.waiting ?? 0,
        active: dlqCounts.active ?? 0,
        completed: dlqCounts.completed ?? 0,
        failed: dlqCounts.failed ?? 0,
        delayed: dlqCounts.delayed ?? 0,
      },
    });
  }));

  // Access: gated by `requirePermission('plugins:write')` (route middleware),
  // matching the sibling retry/replay writes so the queue surface uses ONE gate
  // for org-scoped ops. System admins see all orgs; other holders of
  // plugins:write see only their own org's jobs (tenant-isolation filter below).
  //
  // Paged with `limit` (≤200) + `offset` (≤ QUEUE_MAX_PAGE_DEPTH): every tier's
  // failed set contributes its newest `offset + limit + 1` rows, merged
  // newest-first, so a page is a slice of one global order across tiers — a
  // noisy tier can't crowd out another tier's jobs on a later page.
  router.get('/failed', requirePermission('plugins:write'), withRoute(async ({ req, res, orgId }) => {
    const paging = parseQueuePage(req.query as Record<string, unknown>);
    const tiers = getAllTierQueues();
    const callerIsSysAdmin = isSystemAdmin(req);
    const [failedByTier, counts] = await Promise.all([
      Promise.all(tiers.map(({ queue }) => queue.getJobs(['failed'], 0, paging.offset + paging.limit))),
      callerIsSysAdmin ? Promise.all(tiers.map(({ queue }) => queue.getJobCounts('failed'))) : Promise.resolve(null),
    ]);

    // Tenant isolation: non-system admins only see their own org's failed jobs.
    // Without this filter, an org admin could see another tenant's failure
    // metadata (plugin names, error messages).
    const merged = failedByTier.flat().sort(newestFirst);
    const visible = callerIsSysAdmin ? merged : merged.filter((job) => jobBelongsToOrg(job.data, orgId));
    const total = counts ? counts.reduce((acc, c) => acc + (c.failed ?? 0), 0) : undefined;
    const { page, pagination } = pageOf(visible, paging, total);

    const jobs = page.map((job) => ({
      id: job.id,
      name: job.name,
      pluginName: job.data?.pluginRecord?.name ?? null,
      version: job.data?.pluginRecord?.version ?? null,
      error: job.failedReason ?? null,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts?.attempts ?? null,
      failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString(): null,
    }));

    return sendSuccess(res, 200, { jobs, pagination });
  }));

  /**
   * POST /failed/:jobId/retry — re-enqueue a single FAILED build onto the main
   * build queue from its retained job data. Mirrors /dlq/:jobId/replay but
   * sources from the per-tier failed set (distinct from the DLQ).
   *
   * Access: gated by `requirePermission('plugins:write')` (route middleware).
   * - System admins: can retry any failed job.
   * - Callers with plugins:write: can retry only jobs that belong to their own org.
   *
   * Returns 404 if no failed job with that id exists. The retry carries fresh
   * retry counters; the original failed entry is removed on success.
   */
  router.post('/failed/:jobId/retry', requirePermission('plugins:write'), audited('plugin.build.retry'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const jobId = getParam(req.params, 'jobId');
    if (!jobId) return sendError(res, 400, 'Job ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    // Tenant-isolation: non-system admins can only retry jobs owned by their org.
    const failedJob = await findFailedJob(jobId);
    if (!failedJob) return sendError(res, 404, `Failed job ${jobId} not found`, ErrorCode.NOT_FOUND);

    if (!isSystemAdmin(req) && !jobBelongsToOrg(failedJob.data, orgId)) {
      return sendError(res, 403, 'Cannot retry a job owned by a different org', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const newJobId = await retryFailedJob(jobId, quotaService, retrierFrom(req, userId));
    if (!newJobId) return sendError(res, 404, `Failed job ${jobId} not found`, ErrorCode.NOT_FOUND);

    ctx.log('COMPLETED', 'Retried failed build', { failedJobId: jobId, newJobId });

    // Best-effort attributed audit — a retry re-runs a BUILD (image push +
    // plugin persist) on the caller's authority, so it is a real mutation.
    // Emitted only after the re-enqueue landed. `affectedOrgId` records the
    // job's owning org, which differs from `orgId` for a sysadmin retry.
    emitPluginAudit({
      action: 'plugin.build.retry',
      actorId: actorId({ userId }),
      orgId,
      ...(jobOrgId(failedJob.data) ? { affectedOrgId: jobOrgId(failedJob.data) } : {}),
      targetType: 'plugin',
      details: {
        failedJobId: jobId,
        newJobId,
        pluginName: failedJob.data?.pluginRecord?.name ?? null,
        version: failedJob.data?.pluginRecord?.version ?? null,
      },
    });

    return sendSuccess(res, 200, { retried: true, failedJobId: jobId, newJobId });
  }));

  // -- DLQ endpoints --------------------------------------------------------

  // Access: gated by `requirePermission('plugins:write')` (route middleware) —
  // same org-scoped gate as GET /failed. System admins see all orgs; other
  // plugins:write holders see only their own org (tenant-isolation filter below).
  // Paged exactly like /failed: BullMQ applies the range to EACH state set, so
  // every state contributes its newest `offset + limit + 1` rows before the
  // newest-first merge + slice.
  router.get('/dlq', requirePermission('plugins:write'), withRoute(async ({ req, res, orgId }) => {
    const paging = parseQueuePage(req.query as Record<string, unknown>);
    const dlq = getDeadLetterQueue();
    const states = ['waiting', 'delayed', 'active', 'completed', 'failed'] as const;
    const callerIsSysAdmin = isSystemAdmin(req);
    const [allJobs, counts] = await Promise.all([
      dlq.getJobs([...states], 0, paging.offset + paging.limit),
      callerIsSysAdmin ? dlq.getJobCounts(...states) : Promise.resolve(null),
    ]);

    // Tenant isolation — same model as /failed above.
    const merged = [...allJobs].sort(newestFirst);
    const visible = callerIsSysAdmin ? merged : merged.filter((job) => jobBelongsToOrg(job.data, orgId));
    const total = counts ? states.reduce((acc, st) => acc + (counts[st] ?? 0), 0) : undefined;
    const { page, pagination } = pageOf(visible, paging, total);

    const jobs = page.map((job) => ({
      id: job.id,
      name: job.name,
      pluginName: job.data?.pluginRecord?.name ?? null,
      version: job.data?.pluginRecord?.version ?? null,
      failureCategory: job.data?.failureCategory ?? null,
      lastError: job.data?.lastError ?? job.failedReason ?? null,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts?.attempts ?? null,
      createdAt: job.timestamp ? new Date(job.timestamp).toISOString(): null,
      failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString(): null,
    }));

    return sendSuccess(res, 200, { jobs, pagination });
  }));

  // Access: `requireSystemAdmin` (route middleware) — the purge discards every
  // org's dead-lettered builds, so it is operator-only. The gate replaces the
  // equivalent in-handler check so the route table can see the requirement.
  router.delete('/dlq', requireSystemAdmin, audited('plugin.dlq.purge'), withRoute(async ({ res, userId }) => {
    const purgedCount = await purgeDlq(quotaService);

    // Best-effort attributed audit — the purge discards ALL dead-lettered build
    // jobs cross-org, so this is a sysadmin-only destructive op. `details`
    // carries only the count (no per-job / cross-org identifiers).
    emitPluginAudit({
      action: 'plugin.dlq.purge',
      actorId: actorId({ userId }),
      details: { purgedCount },
    });

    return sendSuccess(res, 200, { message: 'DLQ purged' });
  }));

  /**
   * POST /dlq/:jobId/replay  re-enqueue a single DLQ job onto the main build queue.
   *
   * Access: gated by `requirePermission('plugins:write')` (route middleware).
   * - System admins: can replay any job.
   * - Callers with plugins:write: can replay jobs that belong to their own org.
   *
   * Returns 404 if the DLQ job no longer exists. The replay carries fresh retry
   * counters; the original DLQ entry is removed on success.
   */
  router.post('/dlq/:jobId/replay', requirePermission('plugins:write'), audited('plugin.dlq.replay'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const jobId = getParam(req.params, 'jobId');
    if (!jobId) return sendError(res, 400, 'Job ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    // Tenant-isolation: non-system admins can only replay jobs owned by their org.
    const dlq = getDeadLetterQueue();
    const dlqJob = await dlq.getJob(jobId);
    if (!dlqJob) return sendError(res, 404, `DLQ job ${jobId} not found`, ErrorCode.NOT_FOUND);

    if (!isSystemAdmin(req) && !jobBelongsToOrg(dlqJob.data, orgId)) {
      return sendError(res, 403, 'Cannot replay a job owned by a different org', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const newJobId = await replayDlqJob(jobId, quotaService, retrierFrom(req, userId));
    if (!newJobId) return sendError(res, 404, `DLQ job ${jobId} not found`, ErrorCode.NOT_FOUND);

    ctx.log('COMPLETED', 'Replayed DLQ job', { dlqJobId: jobId, newJobId });

    // Best-effort attributed audit — same rationale as the failed-build retry
    // above: a replay re-runs a build on the caller's authority. Emitted only
    // after the re-enqueue landed.
    emitPluginAudit({
      action: 'plugin.dlq.replay',
      actorId: actorId({ userId }),
      orgId,
      ...(jobOrgId(dlqJob.data) ? { affectedOrgId: jobOrgId(dlqJob.data) } : {}),
      targetType: 'plugin',
      details: {
        dlqJobId: jobId,
        newJobId,
        pluginName: dlqJob.data?.pluginRecord?.name ?? null,
        version: dlqJob.data?.pluginRecord?.version ?? null,
      },
    });

    return sendSuccess(res, 200, { replayed: true, dlqJobId: jobId, newJobId });
  }));

  /**
   * GET /triage  failed-build summary grouped by failure category, with
   * a few representative examples per group. Powers the triage dashboard.
   *
   * Access: gated by `requirePermission('plugins:write')` (route middleware) —
   * same org-scoped gate as GET /failed and GET /dlq.
   * Visibility:
   * - System admins: see all failures across all orgs.
   * - Other plugins:write holders: see only failures whose `pluginRecord.orgId`
   *   matches their org (tenant-isolation filter below).
   */
  router.get('/triage', requirePermission('plugins:write'), withRoute(async ({ req, res, orgId }) => {
    const isSuperAdmin = isSystemAdmin(req);

    const sampleLimit = Math.min(parseQueryInt(req.query.samples, 5), 20);

    // Short-TTL memo (see TRIAGE_CACHE_TTL_MS): collapse a dashboard's repeated
    // polls into one ~1200-payload scan. Scope the key by visibility so a
    // sysadmin's cross-org view can't leak to an org-scoped caller.
    const cacheKey = `${isSuperAdmin ? 'all' : `org:${orgId}`}:${sampleLimit}`;
    const now = Date.now();
    const cached = triageCache.get(cacheKey);
    if (cached && cached.expires > now) {
      return sendSuccess(res, 200, cached.payload);
    }

    // failed jobs sit in the per-tier queue that ran them; union.
    const dlq = getDeadLetterQueue();
    const tierQueueHandles = getAllTierQueues();
    const [tierFailedLists, dlqAll] = await Promise.all([
      Promise.all(tierQueueHandles.map(({ queue }) => queue.getJobs(['failed'], 0, 199))),
      dlq.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 199),
    ]);
    const failedAll = tierFailedLists.flat();

    // Filter to caller's org for non-system admins (tenant isolation).
    const ownsJob = (job: Job<PluginBuildJobData>): boolean =>
      isSuperAdmin || jobBelongsToOrg(job.data, orgId);
    const failed = failedAll.filter(ownsJob);
    const dlqJobs = dlqAll.filter(ownsJob);

    interface Bucket {
      category: string;
      count: number;
      pluginNames: Set<string>;
      samples: TriageSample[];
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

    const ingest = (job: Job<PluginBuildJobData>, source: 'queue' | 'dlq') => {
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
          version: job.data?.pluginRecord?.version ?? null,
          error: err,
          failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString(): null,
          source,
        });
      }
    };

    for (const j of failed) ingest(j, 'queue');
    for (const j of dlqJobs) ingest(j, 'dlq');

    const groups: TriageGroup[] = Array.from(buckets.values())
      .map(b => ({
        category: b.category,
        count: b.count,
        pluginNames: Array.from(b.pluginNames).sort(),
        samples: b.samples,
      }))
      .sort((a, b) => b.count - a.count);

    const payload: TriagePayload = {
      totalFailed: failed.length + dlqJobs.length,
      groups,
    };
    // Bound the cache before inserting: sweep expired entries + evict oldest
    // over the cap so the org-keyed map can't grow with tenant count.
    pruneTriageCache(triageCache, now);
    triageCache.set(cacheKey, { expires: now + TRIAGE_CACHE_TTL_MS, payload });

    return sendSuccess(res, 200, payload);
  }));

  return router;
}
