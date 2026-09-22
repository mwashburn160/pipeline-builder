// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The anonymous-submission gate queue (docs/plugin-publishing.md,
 * ): one BullMQ queue, SEPARATE from the per-tier tenant build queues, whose
 * jobs carry nothing but a submission id. The worker runs the quarantine gate
 * pipeline (services/ecosystem/submission-pipeline.ts) — build on the isolated
 * quarantine buildkitd, scan, smoke test — never the tenant build processor,
 * so no tenant credential, org slot or `plugins` row is ever involved.
 *
 * One job per submission (the job id IS the submission id, so a re-verify can't
 * double-run it); a job that keeps failing on infrastructure fails the
 * submission closed (`pipeline` gate) rather than leaving it in review forever.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';

import { getConnectionForDb } from './connections.js';

const logger = createLogger('submission-build-queue');

export const SUBMISSION_QUEUE_NAME = 'plugin-submission-build';
/** Attempts per submission (infrastructure retries; a gate failure is not a retry). */
const ATTEMPTS = 3;

interface SubmissionJobData {
  submissionId: string;
}

let queue: Queue<SubmissionJobData> | null = null;
let worker: Worker<SubmissionJobData> | null = null;

function getQueue(): Queue<SubmissionJobData> {
  if (!queue) {
    queue = new Queue<SubmissionJobData>(SUBMISSION_QUEUE_NAME, {
      connection: getConnectionForDb(0) as ConnectionOptions,
      defaultJobOptions: {
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 7 * 24 * 3600 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    });
  }
  return queue;
}

/** Queue the gate run for a verified submission (idempotent per submission). */
export async function enqueueSubmissionBuild(submissionId: string): Promise<void> {
  await getQueue().add('gates', { submissionId }, { jobId: submissionId });
}

/** Start the (single-concurrency) submission worker. */
export function startSubmissionWorker(): void {
  if (worker) return;
  worker = new Worker<SubmissionJobData>(SUBMISSION_QUEUE_NAME, async (job: Job<SubmissionJobData>) => {
    const { runSubmissionGates } = await import('../services/ecosystem/submission-pipeline.js');
    const outcome = await runSubmissionGates(job.data.submissionId);
    logger.info('Submission gates finished', { submissionId: job.data.submissionId, outcome });
    return { outcome };
  }, {
    connection: getConnectionForDb(0) as ConnectionOptions,
    // One quarantine build at a time: the isolated pool is small by design.
    concurrency: 1,
  });
  worker.on('failed', (job, err) => {
    if (!job) return;
    logger.warn('Submission gate run failed', { submissionId: job.data.submissionId, attempt: job.attemptsMade, error: errorMessage(err) });
    if (job.attemptsMade < (job.opts.attempts ?? ATTEMPTS)) return;
    void import('../services/ecosystem/submission-pipeline.js')
      .then(({ failSubmissionPipeline }) => failSubmissionPipeline(job.data.submissionId, errorMessage(err)))
      .catch((e) => logger.error('Could not fail a stuck submission closed', { submissionId: job.data.submissionId, error: errorMessage(e) }));
  });
  worker.on('error', (err) => logger.error('Submission worker error', { error: err.message }));
}

/** Stop the worker and close the queue (graceful shutdown). */
export async function shutdownSubmissionQueue(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
