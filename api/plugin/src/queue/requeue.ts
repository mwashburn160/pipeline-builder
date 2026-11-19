// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-initiated re-enqueue of a dead build: retrying a job from a tier
 * queue's `failed` set, or replaying one from the dead-letter queue. Both are
 * the same operation — re-reserve a quota slot, re-enqueue the original job data
 * with a fresh retry budget onto the org's tier queue, then drop the source
 * entry — so both funnel through {@link requeueWithFreshBudget}.
 */

import { AppError, createLogger, decrementQuota, ErrorCode, errorMessage, getServiceAuthHeader } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import type { Job } from 'bullmq';

import { releasePluginQuota, reserveReplaySlot } from './build-quota.js';
import { cleanupBuildArtifacts } from './build-workspace.js';
import { DLQ_NAME, dlqJobId, getDeadLetterQueue, getOrgTier, getTierQueue } from './connections.js';
import { withJobLock } from './job-lock.js';
import type { PluginBuildJobData, PublishCaller } from '../helpers/plugin-helpers.js';

const logger = createLogger('plugin-build-queue');

/**
 * Who is re-running the build. A retry or replay runs on the RETRYING
 * caller's authority, never the original uploader's snapshot: the new job's
 * `userId` and overwrite `access` are theirs, `public` visibility survives only
 * if they hold `plugins:publish`, and the post-build publish request is
 * submitted as them — or dropped when they can't publish.
 */
export interface Retrier {
  userId: string;
  isSystemAdmin: boolean;
  canPublish: boolean;
  /** The retrier as a publish-request submitter. */
  caller: PublishCaller;
}

/** A re-enqueue refused before anything was queued (no quota slot for a non-sysadmin). */
class RequeueRefusedError extends AppError {
  constructor(message: string, statusCode: 429 | 503, code: ErrorCode) {
    super(statusCode, code, message);
    this.name = 'RequeueRefusedError';
  }
}

interface RequeueOptions {
  /** Id the operator addressed (log correlation). */
  jobId: string;
  /** Name prefix for the new tier-queue job (`retry` / `replay`). */
  namePrefix: 'retry' | 'replay';
  /** Whether the source entry still exists after a failed `remove()`. */
  sourceStillPresent: () => Promise<boolean>;
}

/**
 * Re-enqueue `source`'s job data onto the org's tier queue with a fresh retry
 * budget and hand it a freshly reserved `plugins` slot. Returns the new job id.
 *
 * - The source already RELEASED its slot on terminal failure, so the new job
 *   re-reserves one ({@link reserveReplaySlot}); with none to be had only a
 *   system admin's re-run proceeds slot-less ({@link RequeueRefusedError} otherwise).
 * - The new job runs as the RETRIER ({@link Retrier}).
 * - If the enqueue throws, the slot reserved for it is released (with its
 *   period snapshot, so a reset in between can't steal new-period capacity) and
 *   the error propagates.
 * - Removing the source is best-effort: the build is already queued, and
 *   throwing would invite an operator retry that enqueues a SECOND concurrent
 *   build. A source that genuinely lingers is logged loudly for manual cleanup.
 */
async function requeueWithFreshBudget(
  source: Job<PluginBuildJobData>,
  quotaService: QuotaService,
  retrier: Retrier,
  { jobId, namePrefix, sourceStillPresent }: RequeueOptions,
): Promise<string> {
  const { orgId } = source.data;
  const authHeader = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });
  const { quotaReleased, reservedResetAt, noSlot } = await reserveReplaySlot(quotaService, orgId, authHeader, jobId);
  // A slot-less re-run is an operator override of the org's quota: sysadmins only.
  if (noSlot && !retrier.isSystemAdmin) {
    throw noSlot === 'cap'
      ? new RequeueRefusedError('The organization is at its plugin build quota; the build was not re-queued.', 429, ErrorCode.QUOTA_EXCEEDED)
      : new RequeueRefusedError('The quota service is unavailable; try the retry again shortly.', 503, ErrorCode.SERVICE_UNAVAILABLE);
  }

  // Re-derived from the RETRIER (see Retrier): never replay the uploader's authority.
  const visibility = source.data.pluginRecord.visibility === 'public' && !retrier.canPublish ? 'org' : source.data.pluginRecord.visibility;
  const freshData: PluginBuildJobData = {
    ...source.data,
    userId: retrier.userId,
    access: { isSystemAdmin: retrier.isSystemAdmin, canPublish: retrier.canPublish },
    pluginRecord: { ...source.data.pluginRecord, visibility },
    totalAttempts: 0,
    quotaReleased,
    // Fresh period snapshot for the newly reserved slot (undefined when none was
    // reserved) so this re-run's own terminal release is period-safe.
    reservedResetAt,
  };
  delete freshData.lastError;
  delete freshData.failureCategory;
  // A fresh run waits for its slot on a fresh clock (see the DLQ re-queue).
  delete freshData.slotDelays;
  delete freshData.slotWaitStartedAt;
  if (source.data.publish && retrier.canPublish) freshData.publish = { caller: retrier.caller };
  else delete freshData.publish;

  const tier = await getOrgTier(quotaService, orgId, authHeader);

  let requeued: Job<PluginBuildJobData>;
  try {
    requeued = await getTierQueue(tier).add(`${namePrefix}-${source.name}`, freshData);
  } catch (err) {
    // Nothing owns the slot reserved above — release it or it leaks until the
    // quota period resets. At cap (quotaReleased) there is nothing to release.
    if (!quotaReleased) {
      decrementQuota(quotaService, orgId, 'plugins', authHeader, logger.warn.bind(logger), 1, reservedResetAt);
    }
    logger.error(`Build ${namePrefix} enqueue failed; released reserved quota slot`, {
      jobId, orgId, error: errorMessage(err),
    });
    throw err;
  }

  try {
    await source.remove();
  } catch (removeErr) {
    if (await sourceStillPresent().catch(() => false)) {
      logger.warn(`Build ${namePrefix} enqueued but the source entry could not be removed; `
        + 'manual cleanup needed to avoid a duplicate re-run', { jobId, orgId, newJobId: String(requeued.id), error: errorMessage(removeErr) });
    } else {
      logger.debug(`Source entry already removed after ${namePrefix} enqueue`, { jobId });
    }
  }

  return String(requeued.id);
}

/**
 * Retry a single FAILED build from a tier queue's failed set. Takes the EXACT
 * job the caller located (and ownership-checked) with `findFailedJobs` —
 * never a bare id: ids collide across tier queues, so re-looking one up could
 * land on a different tier's job than the one that was authorized. Returns the
 * new job id, or null when that job is no longer failed (a concurrent retry
 * took it) — or when it is already being retried via the DLQ. Runs under a
 * short per-job Redis lock ({@link withJobLock}); a retry that finds it held
 * is refused with a 409 `CONFLICT` (nothing reserved, nothing queued).
 */
export async function retryFailedJob(failedJob: Job<PluginBuildJobData>, quotaService: QuotaService, retrier: Retrier): Promise<string | null> {
  const jobId = String(failedJob.id);
  return withJobLock('retry', failedJob.queueName, jobId, () => retryLockedFailedJob(failedJob, jobId, quotaService, retrier));
}

async function retryLockedFailedJob(failedJob: Job<PluginBuildJobData>, jobId: string, quotaService: QuotaService, retrier: Retrier): Promise<string | null> {
  if (!(await failedJob.isFailed())) return null;

  // Refuse a manual retry when this job has already been handed to the DLQ (a
  // retryable final attempt creates a queue-qualified DLQ entry; the failure
  // handler then removes the tier `failed` entry, but that removal is
  // best-effort and lands just after the DLQ add). Retrying the lingering
  // entry would reserve a SECOND slot and enqueue a SECOND build while the DLQ
  // independently re-queues the same plugin. The DLQ is the single retry
  // vehicle for these; null (→ 404) so the caller doesn't double-run it.
  const dlqTwin = await getDeadLetterQueue().getJob(dlqJobId(failedJob.queueName, jobId));
  if (dlqTwin) {
    logger.info('Refusing manual retry — job is already being retried via the DLQ', { jobId });
    return null;
  }

  return requeueWithFreshBudget(failedJob, quotaService, retrier, {
    jobId,
    namePrefix: 'retry',
    sourceStillPresent: () => failedJob.isFailed(),
  });
}

/** What dismissing a failed build did. */
export interface DismissResult {
  /** The build context (scratch dir + staged object) was deleted by this call. */
  contextReleased: boolean;
  /** The DLQ owns a retry of this build, so its resources were left alone. */
  retryingViaDlq: boolean;
}

/**
 * Dismiss a FAILED build: remove it from its tier's failed set and hand back
 * what it still holds. Takes the SAME job the caller located (and
 * ownership-checked) with `findFailedJobs`, under the job's `retry` lock, so a
 * dismiss and a retry of one build cannot interleave (one gets the 409).
 *
 * Without it a failed row could only be retried, re-uploaded, or left to age
 * out (PLUGIN_BUILD_FAILED_RETENTION_SECS) — and while it sat there a job whose
 * terminal path never ran kept its quota slot and its staged build context.
 *
 * - Quota: `releasePluginQuota` is idempotent (`quotaReleased` /
 *   `slotHandedOff`), so a job the failure path already settled refunds nothing.
 * - Context: deleted unless already cleaned — the job is gone, nothing can
 *   retry from it.
 * - A failed entry whose DLQ twin exists is a lingering duplicate of a build
 *   the DLQ is retrying: only the entry is removed; the DLQ record keeps the
 *   slot and the context it is about to use.
 *
 * Returns null when the job is no longer failed (a concurrent retry took it).
 */
export async function dismissFailedJob(failedJob: Job<PluginBuildJobData>, quotaService: QuotaService): Promise<DismissResult | null> {
  const jobId = String(failedJob.id);
  return withJobLock('retry', failedJob.queueName, jobId, async () => {
    if (!(await failedJob.isFailed())) return null;
    const retryingViaDlq = Boolean(await getDeadLetterQueue().getJob(dlqJobId(failedJob.queueName, jobId)));
    let contextReleased = false;
    if (!retryingViaDlq) {
      releasePluginQuota(failedJob, quotaService);
      if (failedJob.data?.contextCleaned !== true && failedJob.data?.buildRequest) {
        cleanupBuildArtifacts(failedJob.data.buildRequest);
        contextReleased = true;
      }
    }
    await failedJob.remove();
    logger.info('Dismissed failed build', { jobId, queue: failedJob.queueName, retryingViaDlq, contextReleased });
    return { contextReleased, retryingViaDlq };
  });
}

/**
 * Replay a single DLQ job back onto the org's tier queue. Returns the new job
 * id, or null when the DLQ job no longer exists (e.g. a concurrent replay
 * finished first). Runs under the same short per-job Redis lock as a retry
 * ({@link withJobLock}, kind `replay`); a replay that finds it held is refused
 * with a 409 `CONFLICT` (nothing reserved, nothing queued).
 */
export async function replayDlqJob(jobId: string, quotaService: QuotaService, retrier: Retrier): Promise<string | null> {
  return withJobLock('replay', DLQ_NAME, jobId, async () => {
    const dlqJob = await getDeadLetterQueue().getJob(jobId);
    if (!dlqJob) return null;

    return requeueWithFreshBudget(dlqJob, quotaService, retrier, {
      jobId,
      namePrefix: 'replay',
      sourceStillPresent: async () => Boolean(await getDeadLetterQueue().getJob(jobId)),
    });
  });
}
