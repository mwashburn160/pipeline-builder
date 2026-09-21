// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';

import { createLogger, getServiceAuthHeader } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { Worker } from 'bullmq';
import type { Job, ConnectionOptions } from 'bullmq';

import { isFinalAttempt, recordTerminalFailedBuildEvent } from './build-failures.js';
import { releasePluginQuota } from './build-quota.js';
import { BuildContextMissingError, cleanupBuildArtifacts } from './build-workspace.js';
import {
  DLQ_NAME,
  getBuildCfg,
  getConnectionForDb,
  getDeadLetterQueue,
  getOrgTier,
  getTierQueue,
  totalAttemptBudget,
} from './connections.js';
import { intFromEnv } from './env-int.js';
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
 *
 * Exported for the ONE case of abandonment that happens outside this module:
 * `failure-handler` failing to hand a retryable job over to the DLQ at all. That
 * job never enters the DLQ, so no path here can emit for it, and "exactly once"
 * still holds.
 */
export function emitTerminalBuildFailure(job: Job<PluginBuildJobData>, causeMessage: string | undefined): void {
  const { orgId, userId, pluginRecord } = job.data;
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

let dlqWorker: Worker<PluginBuildJobData> | null = null;

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

  // Fetch the two evictable states SEPARATELY, because they must be purged
  // differently and the old single-list filter could evict neither.
  //
  // A DLQ job's processor SUCCEEDS by re-queueing the build onto the main
  // queue, so a re-queued job sits in `completed` with
  // `attemptsMade (1) < maxAttempts (3)`. The previous filter required
  // `attemptsMade >= maxAttempts`, so it excluded exactly the jobs that
  // actually accumulate — and once `dlqMaxSize` of them were retained,
  // `total < dlqMaxSize` was false forever while every retryable failure ran a
  // full 5-state `getJobs` scan and purged NOTHING.
  const [completed, failed, pending] = await Promise.all([
    q.getJobs(['completed']),
    q.getJobs(['failed']),
    q.getJobs(['waiting', 'delayed', 'active']),
  ]);

  // Terminal failures: nothing more will happen to them, and they still hold
  // the org's build slot + artifacts, so purging must hand both back.
  const terminalFailures = failed.filter((job) => job.attemptsMade >= (job.opts.attempts ?? 1));

  // Re-queued (completed) jobs: the NEW main-queue job now owns the slot AND
  // the build artifacts, so evicting the DLQ record must NOT release either —
  // doing so would free a slot that is still in use and delete the inputs the
  // live build is about to read.
  const requeued = completed;

  const oldestFirst = (a: { timestamp?: number }, b: { timestamp?: number }) => (a.timestamp ?? 0) - (b.timestamp ?? 0);
  requeued.sort(oldestFirst);
  terminalFailures.sort(oldestFirst);

  const purgeCount = completed.length + failed.length + pending.length - cfg.dlqMaxSize + 1;
  if (purgeCount <= 0) return;

  // Drop the already-handed-off records first — they are pure bookkeeping —
  // before touching terminal failures, which still carry recoverable context.
  const toPurge = [
    ...requeued.map((job) => ({ job, releaseResources: false })),
    ...terminalFailures.map((job) => ({ job, releaseResources: true })),
  ].slice(0, purgeCount);

  for (const { job, releaseResources } of toPurge) {
    if (releaseResources) {
      // Give the slot back unless the job already released it on exhaustion
      // (its terminal handler decremented + marked it) — purging is otherwise a
      // silent quota leak for any not-yet-terminal job we evict for capacity.
      releasePluginQuota(job, quotaService);
      cleanupBuildArtifacts(job.data.buildRequest);
    }
    try { await job.remove(); } catch { /* best-effort */ }
    logger.info('Purged DLQ job', {
      jobId: job.id,
      pluginName: job.data.pluginRecord.name,
      reason: releaseResources ? 'terminal-failure' : 'already-requeued',
    });
  }
}

export async function purgeDlq(quotaService: QuotaService): Promise<number> {
  const q = getDeadLetterQueue();
  // Split by state for the SAME reason `enforceDlqMaxSize` does. A DLQ job's
  // processor succeeds by re-queueing the build onto the MAIN queue, so a
  // `completed` DLQ record means a retry is in flight and the new main-queue job
  // now owns the org's build slot AND the build artifacts. Releasing those here
  // freed a slot still in use and deleted the inputs a live build was about to
  // read — an operator "clear the DLQ" quietly broke every in-flight retry.
  // Only jobs that will never run again hand their resources back.
  const [requeued, abandoned] = await Promise.all([
    q.getJobs(['completed']),
    q.getJobs(['waiting', 'delayed', 'failed']),
  ]);

  for (const job of abandoned) {
    // Release each still-reserved slot before obliterating — jobs that never
    // reached a terminal handler would otherwise leak quota until period reset.
    releasePluginQuota(job, quotaService);
    cleanupBuildArtifacts(job.data.buildRequest);
  }
  await q.obliterate({ force: true });
  return requeued.length + abandoned.length;
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
      // Unrecoverable: no retry can bring a vanished context back.
      if (!fs.existsSync(buildRequest.contextDir) && !buildRequest.s3Key) {
        throw new BuildContextMissingError(`${buildRequest.contextDir} (no S3 key to restore from)`);
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
      // completed DLQ job (retained up to removeOnComplete's count cap).
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

    const final = isFinalAttempt(job, error);

    logger.error('DLQ retry failed', {
      jobId: job.id,
      pluginName: job.data.pluginRecord.name,
      error: error.message,
      attemptsMade: job.attemptsMade,
      isFinalAttempt: final,
    });

    if (final) {
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
