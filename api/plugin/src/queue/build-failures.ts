// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Turning a failed build into something a human and the reporting pipeline can
 * both read: a one-line summary, a coarse failure class, and the durable build
 * event rows.
 *
 * Split out of plugin-build-queue.ts for size. These are pure-ish leaf helpers —
 * the worker calls them, nothing here calls back into the worker.
 */

import { AppError, createLogger, errorMessage, extractDbError } from '@pipeline-builder/api-core';
import { db, schema, reportingService, runWithTenantContext, withTenantTx } from '@pipeline-builder/pipeline-data';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { BuildProcessError, maskSecrets } from '../helpers/build-process.js';
import type { FailureCategory } from '../helpers/plugin-helpers.js';

const logger = createLogger('plugin-build-queue');

/**
 * Build a bounded, secret-masked failure summary for the user's SSE stream.
 * A {@link BuildProcessError} carries the exit reason + a tail of the last N
 * masked build lines; any other failure (deploy, compliance, validation) degrades
 * to the masked error message. Never includes unbounded output.
 */
export function summarizeBuildFailure(error: Error, isTimeout: boolean): { message: string; reason: string; tail: string[] } {
  if (error instanceof BuildProcessError) {
    const reason = error.timedOut || isTimeout
      ? 'timed out'
      : (error.exitCode != null ? `exit code ${error.exitCode}` : 'error');
    const tail = error.tail ?? [];
    const tailBlock = tail.length > 0 ? `\nLast ${tail.length} log line(s):\n${tail.join('\n')}` : '';
    return { message: `Build failed (${reason})${tailBlock}`, reason, tail };
  }
  const reason = isTimeout ? 'timed out' : 'error';
  // Mask the fallback message defensively — a deploy/compliance error string
  // could conceivably echo a token; the build tail is already masked at source.
  return { message: `Build failed (${reason}): ${maskSecrets(error.message)}`, reason, tail: [] };
}

/**
 * Whether this failure ends the job's run in its queue. Normally that is the
 * last configured attempt, but BullMQ fails an {@link UnrecoverableError}
 * immediately regardless of the attempts left — treating that as non-final
 * would skip the terminal release/cleanup and leak the org's quota slot.
 */
export function isFinalAttempt(job: Pick<Job, 'attemptsMade' | 'opts'>, error: Error): boolean {
  return error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
}

export function classifyFailure(error: Error): FailureCategory {
  const msg = error.message;
  const dbCode = extractDbError(error)?.dbCode;

  // BullMQ never retries an UnrecoverableError (e.g. a vanished build context),
  // so it can only ever be terminal.
  if (error instanceof UnrecoverableError) return 'permanent';

  // A typed client refusal (e.g. deployVersion's 403/409 overwrite gate) will
  // refuse identically on every retry — don't burn the rebuild budget on it.
  if (error instanceof AppError && error.statusCode < 500) return 'permanent';

  if (dbCode === '42703' || dbCode === '42P01' || dbCode === '23505') return 'permanent';
  if (msg.includes('COMPLIANCE_VIOLATION') || msg.includes('VALIDATION_ERROR')) return 'permanent';
  if (msg.includes('missing image.tar') || msg.includes('Tarball not found')) return 'permanent';

  return 'retryable';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Persist a plugin build event then invalidate the org's reporting cache.
 *
 * Order matters: invalidate ONLY after the insert resolves so a failed
 * insert never wipes a still-fresh cache.
 */
export function recordBuildEvent(orgId: string, status: 'completed' | 'failed', job: Job, detail: Record<string, unknown>): void {
  const startedMs = job.processedOn ?? job.timestamp;
  const completedMs = job.finishedOn ?? Date.now();
  const durationMs = startedMs ? completedMs - startedMs : undefined;

  if (!db?.insert) return;

  withTenantTx((tx) => tx.insert(schema.pipelineEvent)
    .values({
      orgId,
      eventSource: 'plugin-build',
      eventType: 'BUILD',
      status,
      executionId: job.id ?? undefined,
      errorMessage: status === 'failed' ? (detail.errorMessage as string) : undefined,
      startedAt: startedMs ? new Date(startedMs) : undefined,
      completedAt: new Date(completedMs),
      durationMs,
      detail: {
        ...detail,
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts,
      },
    })
    // BullMQ may re-run a job (retry/stalled-recovery) and re-record the same
    // (execution_id=jobId) BUILD event; dedup on the event_dedup_idx instead of
    // inserting duplicate rows that inflate build metrics.
    .onConflictDoNothing())
    .then(
      () => reportingService.invalidateOrg(orgId).catch((invalidateErr: unknown) => {
        logger.warn('Reporting cache invalidation failed after build event', { orgId, error: errorMessage(invalidateErr) });
      }),
      (insertErr: unknown) => {
        logger.warn('Failed to record build event', { error: errorMessage(insertErr) });
      },
    );
}

/**
 * Record a terminal `failed` build event under a tenant context (the RLS insert
 * in `recordBuildEvent` needs one). Exposed for the DLQ terminal paths, which
 * run detached from the tier worker's `runWithTenantContext`. Keeping the
 * context-wrapping here means the DLQ module needn't depend on pipeline-data
 * directly. Fire-and-forget, mirroring recordBuildEvent.
 */
export function recordTerminalFailedBuildEvent(orgId: string, job: Job, detail: Record<string, unknown>): void {
  void runWithTenantContext({ orgId, isSuperAdmin: false }, async () => {
    recordBuildEvent(orgId, 'failed', job, detail);
  });
}
