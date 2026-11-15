// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  isoOrNull,
  envInt, ErrorCode, audited, getParam, isSystemAdmin, isSystemOrgRequest, paginationMeta, parsePage, parseQueryInt, refuseWeakSession, requireSystemOrgPermission, sendError, sendSuccess, actorId, tagRouteGate, userHasPermission,
  recordAudit, recordAuthzDenial, SYSTEM_ORG_ID, VALID_TIERS, buildConcurrencyEnvVar, buildWorkerConcurrencyFor,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import type { Job } from 'bullmq';
import { Router, type NextFunction, type Request, type Response } from 'express';

import type { PluginBuildJobData } from '../helpers/plugin-helpers.js';
import { findFailedJob, getAllTierQueues, getDeadLetterQueue } from '../queue/connections.js';
import { purgeDlq } from '../queue/plugin-build-dlq.js';
import { replayDlqJob, retryFailedJob, type Retrier } from '../queue/requeue.js';
import { maxBuildsPerOrg, orgSlotSnapshot } from '../queue/slot-manager.js';
import { callerFromRequest } from '../services/ecosystem/context.js';

/** Cap on the job ids listed in one `plugin.dlq.purge` event (the count is always exact). */
const DLQ_PURGE_AUDIT_JOB_CAP = 200;

/**
 * The caller re-running a build: the re-run gets THEIR authority, and
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

/**
 * Whether the caller sees — and may retry / replay — EVERY org's jobs: the
 * system org's queue operators (`plugin_queue:manage`, the permission `/status`
 * and `DELETE /dlq` require), acting from the system org. The superadmin flag
 * alone, from inside a tenant org, is not that: there the caller sees its own
 * org's jobs like any other `plugins:write` holder.
 */
function seesEveryOrg(req: Request): boolean {
  return isSystemOrgRequest(req) && userHasPermission(req, 'plugin_queue:manage');
}

/**
 * The gate on the org-scoped queue routes (`GET /failed`, `GET /dlq`,
 * `GET /triage`, retry, replay). Two principals reach them:
 *
 *  - a system-org queue operator ({@link seesEveryOrg}) — the holder of
 *    `plugin_queue:manage` the Builds page is gated on. It sees and acts on
 *    every org's jobs, so, like `/status` and `DELETE /dlq`, it must present an
 *    MFA-grade session;
 *  - a holder of `plugins:write` in any org, confined to its own org's jobs by
 *    the handlers' tenant filter.
 *
 * A static `requirePermission('plugins:write', 'plugin_queue:manage')` cannot
 * say this: an any-of would admit `plugin_queue:manage` without the system-org
 * and aal2 conditions, so the rule is declared as a dynamic one on the table.
 */
const QUEUE_ACCESS_RULE = 'a system-org queue operator (plugin_queue:manage, aal2) sees every org\'s jobs; '
  + 'any other holder of plugins:write sees only its own org\'s';
const requireQueueAccess = tagRouteGate(
  function queueAccessGate(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      sendError(res, 401, 'Authentication required', ErrorCode.UNAUTHORIZED);
      return;
    }
    if (seesEveryOrg(req)) {
      if (refuseWeakSession(req, res, { minAssurance: 2 })) return;
      next();
      return;
    }
    if (userHasPermission(req, 'plugins:write')) {
      next();
      return;
    }
    recordAuthzDenial(req, 'plugins:write or system-org plugin_queue:manage');
    sendError(res, 403, 'Missing required permission: plugins:write', ErrorCode.INSUFFICIENT_PERMISSIONS);
  },
  {
    kind: 'dynamicAuthz',
    rule: QUEUE_ACCESS_RULE,
    reachableBy: ['superadmin', 'system-org', 'tenant-member'],
    permissions: ['plugins:write', 'plugin_queue:manage'],
  },
);

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
 * TTL (ms) for the GET /triage aggregate memo. The triage scan pulls 200 job
 * payloads per source (each tier queue, the DLQ) — more for a tenant, whose
 * scan reads past other orgs' jobs up to PLUGIN_QUEUE_TENANT_SCAN_MAX_ROWS per
 * source — and buckets them in-memory on EVERY request; a short-TTL memo collapses a dashboard's repeated
 * polls into one scan without letting the summary go meaningfully stale. Mirrors
 * the read-quotas at-risk cache pattern.
 */
const TRIAGE_CACHE_TTL_MS = envInt('PLUGIN_TRIAGE_CACHE_TTL_MS', 5000, { min: 1 });

/**
 * Hard cap on distinct triage cache keys. Unlike the operator-only read-quotas
 * cache, `/triage` is org-callable and keyed `all|org:<orgId>:<sampleLimit>`, so
 * the key space grows with tenant count. Expired entries are only overwritten on
 * re-access, so an org that polls once and never returns would otherwise leave a
 * stale entry forever. Sweep expired entries on write and, if still over the
 * cap, evict the oldest (Map preserves insertion order) to bound memory.
 */
const TRIAGE_CACHE_MAX_ENTRIES = envInt('PLUGIN_TRIAGE_CACHE_MAX_ENTRIES', 500, { min: 1 });

/** Jobs per source (tier failed set / DLQ) the triage summary buckets. */
const TRIAGE_SOURCE_ROWS = 200;

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
const QUEUE_MAX_PAGE_DEPTH = envInt('PLUGIN_QUEUE_MAX_PAGE_DEPTH', 5000, { min: 1 });

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

/**
 * Deepest row a TENANT-scoped read scans in one source (a tier's failed set, or
 * one DLQ state set). BullMQ has no per-org index, so a tenant's page is found
 * by reading a source newest-first in {@link TENANT_SCAN_CHUNK} slices and
 * keeping the caller's own jobs until it has enough or reaches this depth.
 * Older jobs of that tenant beyond it are not listed.
 */
const TENANT_SCAN_MAX_ROWS = envInt('PLUGIN_QUEUE_TENANT_SCAN_MAX_ROWS', 10000, { min: 1 });

/** Rows per BullMQ range read while scanning a source for a tenant. */
const TENANT_SCAN_CHUNK = 500;

/** One source of jobs: reads rows `start..end` (inclusive) newest-first. */
type JobRangeReader = (start: number, end: number) => Promise<Job<PluginBuildJobData>[]>;

/**
 * The newest `want` jobs of one source that `keep` admits, scanning in chunks
 * up to {@link TENANT_SCAN_MAX_ROWS}. Stops early once a short chunk shows the
 * source is exhausted. Filtering BEFORE limiting is what keeps another org's
 * failures from pushing the caller's own jobs out of the page.
 */
async function scanSource(
  read: JobRangeReader,
  want: number,
  keep: (job: Job<PluginBuildJobData>) => boolean,
): Promise<Job<PluginBuildJobData>[]> {
  const found: Job<PluginBuildJobData>[] = [];
  for (let start = 0; start < TENANT_SCAN_MAX_ROWS && found.length < want; start += TENANT_SCAN_CHUNK) {
    const end = Math.min(start + TENANT_SCAN_CHUNK, TENANT_SCAN_MAX_ROWS) - 1;
    const rows = await read(start, end);
    for (const job of rows) {
      if (keep(job)) found.push(job);
    }
    if (rows.length < end - start + 1) break;
  }
  return found.slice(0, want);
}

/**
 * Read `want` jobs from each source: an operator's first `want` rows as they
 * stand (every job is visible), or a tenant's own newest `want` per source.
 * Taking each source's own top `want` makes the newest-first merge of their
 * union exact for the first `want` rows overall.
 */
async function readSources(
  sources: JobRangeReader[],
  want: number,
  everyOrg: boolean,
  orgId: string,
): Promise<Job<PluginBuildJobData>[]> {
  const lists = await Promise.all(sources.map((read) => (everyOrg
    ? read(0, want - 1)
    : scanSource(read, want, (job) => jobBelongsToOrg(job.data, orgId)))));
  return lists.flat();
}

/** The DLQ's state sets, each its own BullMQ set and so its own scan source. */
const DLQ_STATES = ['waiting', 'delayed', 'active', 'completed', 'failed'] as const;

/** Newest-first order over a merged multi-queue read (finished, else enqueued). */
const newestFirst = (a: Job, b: Job): number =>
  ((b.finishedOn ?? b.timestamp ?? 0) - (a.finishedOn ?? a.timestamp ?? 0));

/**
 * One page of a merged, tenant-filtered job listing. `window` holds the first
 * `offset + limit + 1` VISIBLE rows of every source (see {@link readSources})
 * already merged newest-first, so the
 * page is a slice of a stable global order and the extra row tells us whether
 * another page exists. `total` is exact for system-org queue operators (the queue counts
 * cover every tenant); a tenant-scoped caller's total can't be known without
 * scanning every tenant's jobs, so it is omitted and `hasMore` drives paging.
 */
function pageOf<T extends Job>(
  window: T[],
  { limit, offset }: { limit: number; offset: number },
  total: number | undefined,
): { page: T[]; pagination: { total?: number; limit: number; offset: number; hasMore: boolean } } {
  const page = window.slice(offset, offset + limit);
  // With a known total the shared rule applies; without one (a tenant-scoped
  // caller, whose total can't be counted) the peeked extra row is the signal.
  const hasMore = total !== undefined
    ? paginationMeta({ total, offset, limit, returned: page.length }).hasMore
    : window.length > offset + limit;
  return { page, pagination: { ...(total !== undefined ? { total } : {}), limit, offset, hasMore } };
}

/** A build job's owning org. */
const jobOrgId = (data: { orgId?: string } | undefined): string | undefined => data?.orgId;

/** True when a job belongs to `orgId` (case-insensitive). Used for the
 *  non-system-admin tenant-isolation filter across the failed/DLQ endpoints. */
const jobBelongsToOrg = (
  data: { orgId?: string } | undefined,
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
  // visibility scope (`all` for system-org queue operators vs the caller's own org) + the
  // requested sample count, so a sysadmin's cross-org summary is never served to
  // an org-scoped caller and vice-versa.
  const triageCache = new Map<string, TriageCacheEntry>();

  // Access: `requireSystemOrgPermission('plugin_queue:manage')` (route
  // middleware) — the counts aggregate across every tenant's builds, so this is
  // an operator-only view, declared on the route so the route table sees it.
  router.get('/status', ...requireSystemOrgPermission('plugin_queue:manage'), withRoute(async ({ res }) => {
    // counts aggregate across all per-tier queues so existing
    // dashboard widgets keep their meaning. Per-tier breakdown is on the
    // returned `tiers` field for operators that want it.
    const tierQueues = getAllTierQueues();
    const dlq = getDeadLetterQueue();
    const [tierCounts, dlqCounts, slots] = await Promise.all([
      Promise.all(tierQueues.map(async ({ tier, queue }) => ({ tier, counts: await queue.getJobCounts() }))),
      dlq.getJobCounts(),
      // Per-ORG detail, which the gauges deliberately omit (tenant cardinality
      // in a metric store). System-org only route, so the org ids are fine here.
      orgSlotSnapshot().catch(() => []),
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
      /**
       * The per-org build SLOTS, as the semaphore actually holds them.
       *
       * `held` is the jobs owning a slot; `counted` is the number the cap is
       * compared against; `leaked` is the gap. A positive gap is capacity that
       * has silently gone missing — an org pinned at its cap for that reason
       * refuses builds for PLUGIN_ORG_SLOT_MAX_WAIT_MS and then fails them,
       * which from outside is indistinguishable from a cap that is simply too
       * low. Neither figure was visible anywhere before, so telling those two
       * apart meant reading logs after the fact.
       *
       * Degrades to an empty list rather than failing the whole status read: a
       * queue dashboard that goes blank because a diagnostic aside could not be
       * computed is worse than one missing the aside.
       */
      orgSlots: slots,
      /**
       * The two limits side by side, because the LOWER of them binds and the
       * per-org cap looks like a throughput knob when it is not. A tier whose
       * `workerConcurrency` is under its `orgSlots` cannot reach that cap at
       * all, so raising the cap for it changes nothing.
       */
      limits: Object.fromEntries(VALID_TIERS.map((tier) => [tier, {
        workerConcurrency: envInt(buildConcurrencyEnvVar(tier), buildWorkerConcurrencyFor(tier), { min: 1 }),
        orgSlots: { standard: maxBuildsPerOrg(tier, 'standard'), flexible: maxBuildsPerOrg(tier, 'flexible') },
      }])),
    });
  }));

  // Access: `requireQueueAccess` — the shared gate of the org-scoped queue
  // routes. System-org queue operators see all orgs; other holders of
  // plugins:write see only their own org's jobs (tenant-isolation filter).
  //
  // Paged with `limit` (≤200) + `offset` (≤ QUEUE_MAX_PAGE_DEPTH): every tier's
  // failed set contributes its newest `offset + limit + 1` VISIBLE rows — for a
  // tenant, its own jobs, filtered before the limit so other orgs' failures
  // cannot push them out — merged newest-first, so a page is a slice of one
  // global order across tiers.
  router.get('/failed', requireQueueAccess, withRoute(async ({ req, res, orgId }) => {
    const paging = parseQueuePage(req.query as Record<string, unknown>);
    const tiers = getAllTierQueues();
    const everyOrg = seesEveryOrg(req);
    const want = paging.offset + paging.limit + 1;
    const [failed, counts] = await Promise.all([
      readSources(
        tiers.map(({ queue }) => (start: number, end: number) => queue.getJobs(['failed'], start, end)),
        want, everyOrg, orgId,
      ),
      everyOrg ? Promise.all(tiers.map(({ queue }) => queue.getJobCounts('failed'))) : Promise.resolve(null),
    ]);

    // Tenant isolation already applied by readSources: callers other than
    // system-org queue operators only ever hold their own org's failed jobs, so
    // an org admin never sees another tenant's plugin names or error messages.
    const visible = failed.sort(newestFirst);
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
      failedAt: isoOrNull(job.finishedOn),
      // False once the terminal failure path deleted the build context. Retry
      // would re-enqueue a job that dies immediately in ensureLocalBuildContext
      // with "Build context missing", so the UI offers re-upload instead.
      contextAvailable: job.data?.contextCleaned !== true,
    }));

    return sendSuccess(res, 200, { jobs, pagination });
  }));

  /**
   * POST /failed/:jobId/retry — re-enqueue a single FAILED build onto the main
   * build queue from its retained job data. Mirrors /dlq/:jobId/replay but
   * sources from the per-tier failed set (distinct from the DLQ).
   *
   * Access: `requireQueueAccess`.
   * - System-org queue operators (aal2): can retry any failed job.
   * - Callers with plugins:write: can retry only jobs that belong to their own org.
   *
   * Returns 404 if no failed job with that id exists. The retry carries fresh
   * retry counters; the original failed entry is removed on success.
   */
  router.post('/failed/:jobId/retry', requireQueueAccess, audited('plugin.build.retry'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const jobId = getParam(req.params, 'jobId');
    if (!jobId) return sendError(res, 400, 'Job ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    // Tenant-isolation: callers other than system-org queue operators can only retry jobs owned by their org.
    const failedJob = await findFailedJob(jobId);
    if (!failedJob) return sendError(res, 404, `Failed job ${jobId} not found`, ErrorCode.NOT_FOUND);

    // Another org's job answers exactly like a missing one: BullMQ ids are
    // sequential, so a distinct 403 would let a tenant enumerate which ids
    // exist. The denial still reaches the `authz.denied` trail.
    if (!seesEveryOrg(req) && !jobBelongsToOrg(failedJob.data, orgId)) {
      recordAuthzDenial(req, 'job-owned-by-caller-org');
      return sendError(res, 404, `Failed job ${jobId} not found`, ErrorCode.NOT_FOUND);
    }

    const newJobId = await retryFailedJob(jobId, quotaService, retrierFrom(req, userId));
    if (!newJobId) return sendError(res, 404, `Failed job ${jobId} not found`, ErrorCode.NOT_FOUND);

    ctx.log('COMPLETED', 'Retried failed build', { failedJobId: jobId, newJobId });

    // Best-effort attributed audit — a retry re-runs a BUILD (image push +
    // plugin persist) on the caller's authority, so it is a real mutation.
    // Emitted only after the re-enqueue landed. `affectedOrgId` records the
    // job's owning org, which differs from `orgId` for a sysadmin retry.
    recordAudit({
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

  // Access: `requireQueueAccess` — same gate as GET /failed. System-org queue
  // operators see all orgs; other plugins:write holders see only their own org.
  // Paged exactly like /failed. An operator reads every state set in one call
  // (BullMQ applies the range to EACH set); a tenant's scan runs per state set,
  // so each set contributes its own newest `offset + limit + 1` jobs of the
  // caller's org before the newest-first merge + slice.
  router.get('/dlq', requireQueueAccess, withRoute(async ({ req, res, orgId }) => {
    const paging = parseQueuePage(req.query as Record<string, unknown>);
    const dlq = getDeadLetterQueue();
    const everyOrg = seesEveryOrg(req);
    const want = paging.offset + paging.limit + 1;
    const sources: JobRangeReader[] = everyOrg
      ? [(start, end) => dlq.getJobs([...DLQ_STATES], start, end)]
      : DLQ_STATES.map((state) => (start: number, end: number) => dlq.getJobs([state], start, end));
    const [dlqJobs, counts] = await Promise.all([
      readSources(sources, want, everyOrg, orgId),
      everyOrg ? dlq.getJobCounts(...DLQ_STATES) : Promise.resolve(null),
    ]);

    const visible = dlqJobs.sort(newestFirst);
    const total = counts ? DLQ_STATES.reduce((acc, st) => acc + (counts[st] ?? 0), 0) : undefined;
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
      createdAt: isoOrNull(job.timestamp),
      failedAt: isoOrNull(job.finishedOn),
    }));

    return sendSuccess(res, 200, { jobs, pagination });
  }));

  // Access: `requireSystemOrgPermission('plugin_queue:manage')` (route
  // middleware) — the purge discards every org's dead-lettered builds, so it is
  // operator-only, declared on the route so the route table sees it.
  router.delete('/dlq', ...requireSystemOrgPermission('plugin_queue:manage'), audited('plugin.dlq.purge'), withRoute(async ({ res, userId }) => {
    const purged = await purgeDlq(quotaService);

    // Best-effort attributed audit — the purge discards ALL dead-lettered build
    // jobs cross-org, so this is a system-org destructive op: `orgId` is the
    // system org (an event without one lands in no trail), and `details` list
    // each discarded job id with its owning org so a tenant's lost build is
    // traceable to this purge.
    recordAudit({
      action: 'plugin.dlq.purge',
      actorId: actorId({ userId }),
      orgId: SYSTEM_ORG_ID,
      targetType: 'plugin-build-dlq',
      details: {
        purgedCount: purged.count,
        jobs: purged.jobs.slice(0, DLQ_PURGE_AUDIT_JOB_CAP),
        ...(purged.jobs.length > DLQ_PURGE_AUDIT_JOB_CAP && { jobsTruncated: true }),
      },
    });

    return sendSuccess(res, 200, { message: 'DLQ purged' });
  }));

  /**
   * POST /dlq/:jobId/replay re-enqueue a single DLQ job onto the main build queue.
   *
   * Access: `requireQueueAccess`.
   * - System-org queue operators (aal2): can replay any job.
   * - Callers with plugins:write: can replay jobs that belong to their own org.
   *
   * Returns 404 if the DLQ job no longer exists. The replay carries fresh retry
   * counters; the original DLQ entry is removed on success.
   */
  router.post('/dlq/:jobId/replay', requireQueueAccess, audited('plugin.dlq.replay'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const jobId = getParam(req.params, 'jobId');
    if (!jobId) return sendError(res, 400, 'Job ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    // Tenant-isolation: callers other than system-org queue operators can only replay jobs owned by their org.
    const dlq = getDeadLetterQueue();
    const dlqJob = await dlq.getJob(jobId);
    if (!dlqJob) return sendError(res, 404, `DLQ job ${jobId} not found`, ErrorCode.NOT_FOUND);

    // As for a retry: indistinguishable from a missing job, and audited.
    if (!seesEveryOrg(req) && !jobBelongsToOrg(dlqJob.data, orgId)) {
      recordAuthzDenial(req, 'job-owned-by-caller-org');
      return sendError(res, 404, `DLQ job ${jobId} not found`, ErrorCode.NOT_FOUND);
    }

    const newJobId = await replayDlqJob(jobId, quotaService, retrierFrom(req, userId));
    if (!newJobId) return sendError(res, 404, `DLQ job ${jobId} not found`, ErrorCode.NOT_FOUND);

    ctx.log('COMPLETED', 'Replayed DLQ job', { dlqJobId: jobId, newJobId });

    // Best-effort attributed audit — same rationale as the failed-build retry
    // above: a replay re-runs a build on the caller's authority. Emitted only
    // after the re-enqueue landed.
    recordAudit({
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
   * GET /triage failed-build summary grouped by failure category, with
   * a few representative examples per group. Powers the triage dashboard.
   *
   * Access: `requireQueueAccess` — same gate as GET /failed and GET /dlq.
   * Visibility:
   * - System-org queue operators ({@link seesEveryOrg}): the newest 200 failures
   *   of each source across all orgs.
   * - Other plugins:write holders: the newest 200 of each source whose job
   *   `data.orgId` matches their org, filtered BEFORE the limit.
   */
  router.get('/triage', requireQueueAccess, withRoute(async ({ req, res, orgId }) => {
    const everyOrg = seesEveryOrg(req);

    const sampleLimit = Math.min(parseQueryInt(req.query.samples, 5), 20);

    // Short-TTL memo (see TRIAGE_CACHE_TTL_MS): collapse a dashboard's repeated
    // polls into one scan. Scope the key by visibility so a
    // sysadmin's cross-org view can't leak to an org-scoped caller.
    const cacheKey = `${everyOrg ? 'all' : `org:${orgId}`}:${sampleLimit}`;
    const now = Date.now();
    const cached = triageCache.get(cacheKey);
    if (cached && cached.expires > now) {
      return sendSuccess(res, 200, cached.payload);
    }

    // failed jobs sit in the per-tier queue that ran them; union. Tenant
    // isolation is applied by readSources, before the per-source limit.
    const dlq = getDeadLetterQueue();
    const tierQueueHandles = getAllTierQueues();
    const dlqSources: JobRangeReader[] = everyOrg
      ? [(start, end) => dlq.getJobs([...DLQ_STATES], start, end)]
      : DLQ_STATES.map((state) => (start: number, end: number) => dlq.getJobs([state], start, end));
    const [failed, dlqJobs] = await Promise.all([
      readSources(
        tierQueueHandles.map(({ queue }) => (start: number, end: number) => queue.getJobs(['failed'], start, end)),
        TRIAGE_SOURCE_ROWS, everyOrg, orgId,
      ),
      readSources(dlqSources, TRIAGE_SOURCE_ROWS, everyOrg, orgId),
    ]);

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
          failedAt: isoOrNull(job.finishedOn),
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
