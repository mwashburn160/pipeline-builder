// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';

import { createLogger, decrementQuota, errorMessage, getServiceAuthHeader } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Queue, Worker } from 'bullmq';
import type { Job, ConnectionOptions } from 'bullmq';

import { intFromEnv } from './env-int.js';
import {
  getConnectionForDb,
  getBuildCfg,
  totalAttemptBudget,
  getTierQueue,
  getOrgTier,
  cleanupBuildArtifacts,
  releasePluginQuota,
  reserveReplaySlot,
  recordTerminalFailedBuildEvent,
} from './plugin-build-queue.js';
import type { PluginBuildJobData } from '../helpers/plugin-helpers.js';
import { emitPluginAudit } from '../services/audit.js';

const logger = createLogger('plugin-build-queue');

/**
 * Emit the SINGLE terminal build-failure audit event at TRUE DLQ exhaustion /
 * give-up.
 *
 * The tier queue deliberately SUPPRESSES its final-attempt terminal emit for
 * retryable (DLQ-bound) failures — a DLQ retry may still succeed and produce a
 * `plugin.build.completed`. So for jobs that ultimately die in the DLQ, the one
 * terminal `plugin.build.failed` / `plugin.build.timeout` is emitted here,
 * exactly once, only when the build is genuinely abandoned. `causeMessage`
 * carries the underlying build failure (`job.data.lastError`) so the audit
 * records why the BUILD died, not the DLQ plumbing; `.timeout` is chosen when
 * that cause looks like a timeout, mirroring the tier queue's classification.
 */
function emitTerminalBuildFailure(job: Job<PluginBuildJobData>, causeMessage: string | undefined): void {
  const { orgId, userId, pluginRecord } = job.data;
  // Named causeText (not errorMessage) to avoid shadowing the imported
  // errorMessage() helper used in the replay/catch paths.
  const causeText = causeMessage ?? 'Build failed after exhausting all retries';
  const isTimeout = /timed out|timeout/i.test(causeText);
  emitPluginAudit({
    action: isTimeout ? 'plugin.build.timeout' : 'plugin.build.failed',
    actorId: userId ?? 'system',
    orgId,
    targetType: 'plugin',
    details: {
      pluginName: pluginRecord.name,
      pluginVersion: pluginRecord.version,
      jobId: job.id,
      errorMessage: causeText,
      isTimeout,
    },
  });

  // Record the terminal `failed` build event for DORA metrics. The tier worker
  // deliberately SKIPS the failed event for retryable (DLQ-bound) jobs — a DLQ
  // retry may still succeed — so for a build that ultimately dies in the DLQ,
  // this is the ONLY place a `failed` build event is written. Without it,
  // change-failure-rate / build-failure metrics silently undercount every
  // DLQ-abandoned build. executionId keys on the DLQ job id (distinct from the
  // never-recorded original tier job), so this can't double-count. The helper
  // wraps the RLS insert in tenant context; fire-and-forget.
  recordTerminalFailedBuildEvent(orgId, job, {
    pluginName: pluginRecord.name,
    pluginVersion: pluginRecord.version,
    errorMessage: causeText,
    isTimeout,
  });
}

const QUEUE_NAME = CoreConstants.PLUGIN_BUILD_QUEUE_NAME;
export const DLQ_NAME = `${QUEUE_NAME}-dlq`;

let dlq: Queue<PluginBuildJobData> | null = null;
let dlqWorker: Worker<PluginBuildJobData> | null = null;

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export function getDeadLetterQueue(): Queue<PluginBuildJobData> {
  if (!dlq) {
    dlq = new Queue<PluginBuildJobData>(DLQ_NAME, {
      connection: getConnectionForDb(0) as ConnectionOptions,
      defaultJobOptions: {
        // BOUNDED (was `false`): a DLQ job that re-queues on its first attempt has
        // attemptsMade < maxAttempts, so enforceDlqMaxSize never classifies it
        // terminal and never purges it — with `false` these completed jobs pile up
        // in Redis forever. Cap the retained-completed set so growth is bounded.
        removeOnComplete: { count: 1000 },
        removeOnFail: false,
      },
    });
  }
  return dlq;
}

const DLQ_ENFORCE_SCAN_INTERVAL_MS = intFromEnv('PLUGIN_DLQ_SCAN_INTERVAL_MS', 5000);
let lastDlqEnforceMs = 0;

/**
 * Enforce DLQ max size by purging oldest terminal jobs first. Rate-limited
 * to once per DLQ_ENFORCE_SCAN_INTERVAL_MS and gated by a cheap getJobCounts
 * total-check so the expensive scan only runs when the queue is close to its
 * cap.
 */
export async function enforceDlqMaxSize(quotaService: QuotaService): Promise<void> {
  const now = Date.now();
  if (now - lastDlqEnforceMs < DLQ_ENFORCE_SCAN_INTERVAL_MS) return;
  lastDlqEnforceMs = now;

  const cfg = getBuildCfg();
  const q = getDeadLetterQueue();
  const counts = await q.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total < cfg.dlqMaxSize) return;

  const allJobs = await q.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  const terminalJobs = allJobs.filter((job) => {
    if (job.finishedOn == null) return false;
    const maxAttempts = job.opts.attempts ?? 1;
    return job.attemptsMade >= maxAttempts;
  });

  terminalJobs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const purgeCount = allJobs.length - cfg.dlqMaxSize + 1;
  const toPurge = terminalJobs.slice(0, purgeCount);

  for (const job of toPurge) {
    // Give the slot back unless the job already released it on exhaustion
    // (its terminal handler decremented + marked it) — purging is otherwise a
    // silent quota leak for any not-yet-terminal job we evict for capacity.
    releasePluginQuota(job, quotaService);
    cleanupBuildArtifacts(job.data.buildRequest);
    try { await job.remove(); } catch { /* best-effort */ }
    logger.info('Purged oldest DLQ job', { jobId: job.id, pluginName: job.data.pluginRecord.name });
  }
}

export async function purgeDlq(quotaService: QuotaService): Promise<number> {
  const q = getDeadLetterQueue();
  const jobs = await q.getJobs(['waiting', 'delayed', 'completed', 'failed']);
  for (const job of jobs) {
    // Release each still-reserved slot before obliterating — jobs that never
    // reached a terminal handler would otherwise leak quota until period reset.
    releasePluginQuota(job, quotaService);
    cleanupBuildArtifacts(job.data.buildRequest);
  }
  await q.obliterate({ force: true });
  return jobs.length;
}

/**
 * Replay a single DLQ job back onto the build queue matching the org's tier.
 * Resets retry counters so the job gets a fresh budget. Removes the DLQ
 * entry after successful enqueue so it doesn't show up twice.
 */
export async function replayDlqJob(jobId: string, quotaService: QuotaService): Promise<string | null> {
  const dlqJob = await getDeadLetterQueue().getJob(jobId);
  if (!dlqJob) return null;

  const { orgId } = dlqJob.data;
  const authHeader = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });

  // The DLQ job already RELEASED its plugin slot on terminal failure
  // (quotaReleased:true). A replay is a fresh build attempt, so re-reserve a
  // slot and hand ownership to the new job (quotaReleased:false) — otherwise a
  // successful replay deploys a plugin the org's usage never counts. If the org
  // is at its plugin cap we still replay (an admin action) but the job carries
  // no slot to release, keeping accounting balanced (no double-credit).
  const { quotaReleased, reservedResetAt } = await reserveReplaySlot(quotaService, orgId, authHeader, jobId);

  const freshData: PluginBuildJobData = {
    ...dlqJob.data,
    totalAttempts: 0,
    quotaReleased,
    // Fresh period snapshot for the newly reserved slot (undefined when none was
    // reserved) so this replay's own terminal release is period-safe.
    reservedResetAt,
  };
  delete (freshData as { lastError?: string }).lastError;
  delete (freshData as { failureCategory?: string }).failureCategory;

  const tier = await getOrgTier(quotaService, orgId, authHeader);

  let replayed;
  try {
    replayed = await getTierQueue(tier).add(`replay-${dlqJob.name}`, freshData);
  } catch (err) {
    // Enqueue failed AFTER reserveReplaySlot handed the new job a slot
    // (quotaReleased === false ⇒ a slot was reserved). Nothing owns it now — the
    // DLQ job already released its own slot on terminal failure — so release it
    // here or it leaks until the quota period resets. Mirrors retryFailedJob.
    if (!quotaReleased) {
      decrementQuota(quotaService, orgId, 'plugins', authHeader, logger.warn.bind(logger));
    }
    logger.error('DLQ replay enqueue failed; released reserved quota slot', {
      jobId, orgId, error: errorMessage(err),
    });
    throw err;
  }
  await dlqJob.remove();
  return String(replayed.id);
}

// ---------------------------------------------------------------------------
// DLQ worker -- re-queues retryable jobs back to the main queue
// ---------------------------------------------------------------------------

export function startDlqWorker(quotaService: QuotaService): void {
  if (dlqWorker) return;

  dlqWorker = new Worker<PluginBuildJobData>(DLQ_NAME,
    async (job: Job<PluginBuildJobData>) => {
      const { orgId, pluginRecord, buildRequest, totalAttempts } = job.data;
      const budget = totalAttemptBudget();

      if ((totalAttempts ?? 0) >= budget) {
        cleanupBuildArtifacts(buildRequest);
        releasePluginQuota(job, quotaService);
        emitTerminalBuildFailure(job, job.data.lastError);
        logger.warn('DLQ: max total attempts reached, giving up', {
          jobId: job.id,
          pluginName: pluginRecord.name,
          totalAttempts,
        });
        return;
      }

      // The DLQ worker only re-queues (the main worker rebuilds); it needs the
      // context to still be recoverable. Local dir present ⇒ same replica; else
      // an S3 key means the main worker can rehydrate it (ensureLocalBuildContext).
      if (!fs.existsSync(buildRequest.contextDir) && !buildRequest.s3Key) {
        throw new Error(`Build context missing: ${buildRequest.contextDir} (no S3 key to restore from)`);
      }

      // Best-effort keep-warm of the local dir (no-op when it lives on another
      // replica — the S3 object is what the rebuild will use).
      try { fs.utimesSync(buildRequest.contextDir, new Date(), new Date()); } catch { /* ignore */ }

      logger.info('DLQ: re-queuing job', {
        jobId: job.id,
        pluginName: pluginRecord.name,
        dlqAttempt: job.attemptsMade,
        totalAttempts,
      });

      const { failureCategory: _, lastError: __, ...cleanData } = job.data;
      const tier = await getOrgTier(quotaService, orgId, getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' }));
      await getTierQueue(tier).add(`retry-${pluginRecord.name}`, cleanData);

      // The re-queued job (fresh data, quotaReleased unset) now OWNS this org's
      // plugin-quota slot and will release it on its terminal. Mark the original
      // DLQ job's slot as already accounted so purgeDlq / auto-purge don't release
      // the SAME slot again (double-release) when they later evict this lingering
      // completed DLQ job (kept by removeOnComplete:false).
      job.data.quotaReleased = true;
      await job.updateData(job.data);
    },
    {
      connection: getConnectionForDb(0) as ConnectionOptions,
      concurrency: 1,
    },
  );

  dlqWorker.on('failed', (job, error) => {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade >= maxAttempts;

    logger.error('DLQ retry failed', {
      jobId: job.id,
      pluginName: job.data.pluginRecord.name,
      error: error.message,
      attemptsMade: job.attemptsMade,
      isFinalAttempt,
    });

    if (isFinalAttempt) {
      cleanupBuildArtifacts(job.data.buildRequest);
      releasePluginQuota(job, quotaService);
      // The build is genuinely abandoned — emit the single terminal audit
      // event. Prefer the original build failure (lastError) over this DLQ
      // processing error so the trail records why the BUILD died.
      emitTerminalBuildFailure(job, job.data.lastError ?? error.message);
      logger.warn('DLQ exhausted all retries, cleaned up', {
        jobId: job.id,
        pluginName: job.data.pluginRecord.name,
      });
    }
  });

  dlqWorker.on('completed', (job) => {
    logger.info('DLQ job processed', { jobId: job.id, name: job.name });
  });

  logger.info('DLQ worker started');
}

/** Close the DLQ worker (graceful-shutdown step, before tier workers). */
export async function closeDlqWorker(): Promise<void> {
  if (dlqWorker) {
    await dlqWorker.close();
    dlqWorker = null;
  }
}

/** Close the DLQ queue (graceful-shutdown step, after tier queues). */
export async function closeDlqQueue(): Promise<void> {
  if (dlq) {
    await dlq.close();
    dlq = null;
  }
}
