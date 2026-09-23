// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The tier build workers' `failed` event handler: surface the failure to the
 * user, then — on a job's final attempt — either finish it for good (permanent
 * failure / exhausted budget: release quota, clean up, record the terminal
 * event) or hand it to the dead-letter queue for a delayed retry.
 */

import type { PluginScanFinding, QuotaService } from '@pipeline-builder/api-core';
import { SYSTEM_ACTOR_ID, createLogger, ErrorCode, errorMessage, extractDbError, recordAudit } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import type { Job } from 'bullmq';

import { classifyFailure, isFinalAttempt, recordBuildEvent, summarizeBuildFailure } from './build-failures.js';
import { releasePluginQuota } from './build-quota.js';
import { cleanupBuildArtifacts } from './build-workspace.js';
import { dlqJobId, getBuildCfg, getDeadLetterQueue, totalAttemptBudget } from './connections.js';
import { emitTerminalBuildFailure, enforceDlqMaxSize } from './plugin-build-dlq.js';
import type { PluginBuildJobData } from '../helpers/plugin-helpers.js';
import { notifyVersionBlocked } from '../services/plugin-security-notifications.js';

/** The platform scan gates' terminal build failures (N30 to the org). */
const SCAN_GATE_CODES: readonly string[] = [ErrorCode.IMAGE_SCAN_UNAVAILABLE, ErrorCode.PLUGIN_VULN_GATE];

/**
 * The typed api-core code (and structured details) of a failure — an AppError,
 * or a scan gate's UnrecoverableError carrying one (both have an HTTP
 * `statusCode` beside the `code`) — for the build stream and the failure
 * record. A bare `code` (Node's `ECONNREFUSED` …) is not surfaced.
 */
function failureCode(error: Error): { code?: string; details?: Record<string, unknown> } {
  const { code, statusCode, details } = error as Error & { code?: unknown; statusCode?: unknown; details?: unknown };
  if (typeof code !== 'string' || typeof statusCode !== 'number') return {};
  return { code, ...(details && typeof details === 'object' ? { details: details as Record<string, unknown> } : {}) };
}

const logger = createLogger('plugin-build-queue');

export function createBuildFailedHandler(sseManager: SSEManager, quotaService: QuotaService) {
  return (job: Job<PluginBuildJobData> | undefined, error: Error) => {
    if (!job) return;

    // The 'failed' event fires OUTSIDE the processor's runWithTenantContext, so
    // recordBuildEvent's withTenantTx insert would run with an empty
    // `app.org_id` and RLS silently drops the failed BUILD row (the insert's.
    // catch just logs a warn). Re-establish the job's tenant scope for the
    // whole handler so the failure is recorded (and any other tenant-scoped
    // read/write here is attributable).
    return runWithTenantContext({ orgId: job.data.orgId, isSuperAdmin: false }, async () => {
      const { requestId, orgId, pluginRecord, buildRequest } = job.data;
      const maxAttempts = job.opts.attempts ?? 1;
      const final = isFinalAttempt(job, error);
      // ATTEMPTS, not cycles. `totalAttemptBudget()` is denominated in attempts
      // (`maxAttempts + dlqMaxAttempts * maxAttempts`), so accumulate the real
      // number of builds this job has run — counting one per main-queue
      // exhaustion cycle made the effective budget maxAttempts× the documented one.
      const totalAttempts = (job.data.totalAttempts ?? 0) + job.attemptsMade;

      // Prometheus counter. `plugin_name` is intentionally omitted to keep the
      // label set bounded -- per-plugin drill-down is served via Loki.
      const isTimeout = /timed out|timeout/i.test(error.message);
      incCounter('plugin_builds_total', {
        status: isTimeout ? 'timeout' : 'failed',
        org_id: orgId ?? 'unknown',
      });

      logger.error('Plugin build failed', {
        jobId: job.id,
        requestId,
        error: error.message,
        attemptsMade: job.attemptsMade,
        totalAttempts,
        isFinalAttempt: final,
        ...extractDbError(error),
      });

      // Surface a bounded failure summary (exit reason + last N masked build
      // lines) on the SSE stream instead of a generic "Build failed". A
      // BuildProcessError carries the captured tail; other failures (deploy,
      // compliance) fall back to the masked error message.
      const failureSummary = summarizeBuildFailure(error, isTimeout);
      const typed = failureCode(error);
      sseManager.send(requestId, 'ERROR', failureSummary.message, {
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        maxAttempts,
        reason: failureSummary.reason,
        tail: failureSummary.tail,
        // IMAGE_SCAN_UNAVAILABLE / PLUGIN_VULN_GATE / COMPLIANCE_VIOLATION …: the
        // dashboard maps the code to a clear message (details carry the CVEs).
        ...typed,
      });

      const action = isTimeout ? 'plugin.build.timeout' : 'plugin.build.failed';
      logger.info('Plugin build event', {
        eventCategory: 'plugin-build',
        action,
        event: isTimeout ? 'timeout' : 'failed',
        actorId: job.data.userId ?? SYSTEM_ACTOR_ID,
        orgId,
        targetType: 'plugin',
        pluginName: pluginRecord.name,
        pluginVersion: pluginRecord.version,
        jobId: job.id,
        errorMessage: error.message,
      });

      // The TERMINAL audit event is emitted only at TRUE exhaustion, NOT on
      // every final tier attempt: a retryable final-attempt failure is handed
      // to the DLQ below, which may still succeed. Emitting
      // `plugin.build.failed` here would drop a "failed" into the trail ahead of
      // a later `plugin.build.completed` — a misleading signal. So the terminal
      // event fires only in the permanent/budget-exhausted branch below (the
      // tier give-up) or, for DLQ-bound jobs, in the DLQ on its own exhaustion.
      if (!final) return;

      const category = classifyFailure(error);
      const cfg = getBuildCfg();
      const budget = totalAttemptBudget();

      // Permanent failure: terminal. Decrement here because the job will not
      // reach the DLQ. When the failure IS retryable (DLQ-bound branch below),
      // we deliberately skip decrement -- the dlqWorker's `failed` handler
      // owns the decrement on DLQ exhaustion, otherwise a single retryable
      // failure would double-count.
      if (category === 'permanent' || totalAttempts >= budget) {
        cleanupBuildArtifacts(buildRequest);
        releasePluginQuota(job, quotaService);

        // Record the terminal `failed` build event HERE (not on every attempt): a
        // retryable failure handed to the DLQ may still succeed, and the dedup index
        // keys on status, so a per-attempt `failed` row would survive alongside a
        // later `completed` — miscounting a succeeded-after-retry build as failed.
        recordBuildEvent(orgId, 'failed', job, {
          pluginName: pluginRecord.name,
          pluginVersion: pluginRecord.version,
          errorMessage: error.message,
          ...(typed.code ? { errorCode: typed.code } : {}),
        });

        // TRUE terminal at the tier level: a permanent failure never reaches
        // the DLQ, and a retryable one that has burned the whole main+DLQ
        // budget is done. This is the single terminal audit event for these
        // jobs (DLQ-bound jobs get theirs from the DLQ on its own exhaustion).
        recordAudit({
          action,
          actorId: job.data.userId ?? SYSTEM_ACTOR_ID,
          orgId,
          targetType: 'plugin',
          details: {
            pluginName: pluginRecord.name,
            pluginVersion: pluginRecord.version,
            jobId: job.id,
            errorMessage: error.message,
            isTimeout,
            ...(typed.code ? { errorCode: typed.code } : {}),
          },
        });

        // A platform scan gate blocked the version: tell the org (N30), per its
        // plugin security notification settings. Never fails the handler.
        if (typed.code && SCAN_GATE_CODES.includes(typed.code)) {
          const d = (typed.details ?? {}) as { critical?: number; high?: number; findings?: PluginScanFinding[] };
          await notifyVersionBlocked({
            orgId,
            uploaderId: job.data.userId ?? null,
            plugin: pluginRecord.name,
            version: pluginRecord.version,
            code: typed.code,
            message: error.message,
            ...(typeof d.critical === 'number' ? { critical: d.critical } : {}),
            ...(typeof d.high === 'number' ? { high: d.high } : {}),
            ...(Array.isArray(d.findings) ? { findings: d.findings } : {}),
          });
        }

        logger.warn('Permanent failure, cleaned up', {
          jobId: job.id,
          pluginName: pluginRecord.name,
          category,
          totalAttempts,
        });
        return;
      }

      // Retryable: move to DLQ for retry (keep dir alive; do NOT decrement
      // quota -- the DLQ exhaustion path owns that decrement).
      const dlqData: PluginBuildJobData = {
        ...job.data,
        failureCategory: category,
        lastError: error.message,
        totalAttempts,
      };

      enforceDlqMaxSize(quotaService)
        .then(() => getDeadLetterQueue().add(dlqJobId(job.queueName, String(job.id)), dlqData, {
          jobId: dlqJobId(job.queueName, String(job.id)),
          attempts: cfg.dlqMaxAttempts,
          backoff: { type: 'exponential', delay: cfg.dlqBackoffBaseMs },
        }))
        .then(() => {
          logger.info('Moved to DLQ for retry', {
            jobId: job.id,
            pluginName: pluginRecord.name,
            totalAttempts,
            dlqAttempts: cfg.dlqMaxAttempts,
          });
        })
        .catch((dlqErr) => {
          // The hand-off failed, so this job will never run again — that is
          // TERMINAL, and it has to be finished properly rather than merely
          // swept up. Cleaning the artifacts alone left the org's build slot
          // reserved (the comment above defers that decrement to "the DLQ
          // exhaustion path", which this job never reaches, so nothing released
          // it until the quota period reset) and emitted no terminal event, so
          // the build simply disappeared from the user's point of view. Do what
          // the DLQ's own give-up path does.
          logger.warn('Failed to move job to DLQ — abandoning the build', { jobId: job.id, error: errorMessage(dlqErr) });
          cleanupBuildArtifacts(buildRequest);
          releasePluginQuota(job, quotaService);
          emitTerminalBuildFailure(job, error.message);
        });
    });
  };
}
