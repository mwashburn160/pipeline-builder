// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * queue/submission-build-queue.ts: one job per submission (job id = submission
 * id), a single-concurrency worker that runs the quarantine gate pipeline, and
 * the TERMINAL-failure path — a job that exhausted its infrastructure retries
 * fails the submission closed (failSubmissionPipeline) instead of leaving it in
 * review forever. An earlier, retryable failure must NOT fail it.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock, loggerMock } from './helpers/mock-api-core.js';

const logger = loggerMock();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ createLogger: () => logger }));

const queueAdd = jest.fn<AnyFn>(async () => undefined);
const queueClose = jest.fn<AnyFn>(async () => undefined);
const queueCtor = jest.fn<AnyFn>();
const workerClose = jest.fn<AnyFn>(async () => undefined);
const handlers: Record<string, AnyFn> = {};
let processor: AnyFn | undefined;
const workerCtor = jest.fn<AnyFn>();

jest.unstable_mockModule('bullmq', () => ({
  Queue: class {
    constructor(...a: unknown[]) { queueCtor(...a); }
    add(...a: unknown[]) { return queueAdd(...a); }
    close() { return queueClose(); }
  },
  Worker: class {
    constructor(name: string, fn: AnyFn, opts: unknown) { workerCtor(name, opts); processor = fn; }
    on(event: string, fn: AnyFn) { handlers[event] = fn; return this; }
    close() { return workerClose(); }
  },
}));
jest.unstable_mockModule('../src/queue/connections.js', () => ({ getConnectionForDb: (db: number) => ({ db }) }));

const runSubmissionGates = jest.fn<AnyFn>(async () => 'queued_for_review');
const failSubmissionPipeline = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/services/ecosystem/submission-pipeline.js', () => ({ runSubmissionGates, failSubmissionPipeline }));

const q = await import('../src/queue/submission-build-queue.js');

/** Let the fire-and-forget dynamic import + promise chain in the `failed` handler settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

const job = (attemptsMade: number, attempts: number | undefined = 3) => ({ data: { submissionId: 'sub-1' }, attemptsMade, opts: { attempts } });

beforeEach(async () => {
  await q.shutdownSubmissionQueue();
  jest.clearAllMocks();
  for (const k of Object.keys(handlers)) delete handlers[k];
  processor = undefined;
});

describe('enqueue', () => {
  it('queues one idempotent job per submission on its own queue with retries + backoff', async () => {
    await q.enqueueSubmissionBuild('sub-1');
    await q.enqueueSubmissionBuild('sub-2');
    expect(queueCtor).toHaveBeenCalledTimes(1);
    expect(queueCtor).toHaveBeenCalledWith(q.SUBMISSION_QUEUE_NAME, expect.objectContaining({
      connection: { db: 0 },
      defaultJobOptions: expect.objectContaining({ attempts: 3, backoff: { type: 'exponential', delay: 30_000 } }),
    }));
    expect(queueAdd).toHaveBeenCalledWith('gates', { submissionId: 'sub-1' }, { jobId: 'sub-1' });
  });
});

describe('worker', () => {
  it('starts once, single-concurrency, and runs the gate pipeline for the job\'s submission', async () => {
    q.startSubmissionWorker();
    q.startSubmissionWorker();
    expect(workerCtor).toHaveBeenCalledTimes(1);
    expect(workerCtor).toHaveBeenCalledWith(q.SUBMISSION_QUEUE_NAME, expect.objectContaining({ concurrency: 1 }));
    await expect(processor!({ data: { submissionId: 'sub-1' } })).resolves.toEqual({ outcome: 'queued_for_review' });
    expect(runSubmissionGates).toHaveBeenCalledWith('sub-1');
  });

  it('a retryable failure (attempts left) does NOT fail the submission', async () => {
    q.startSubmissionWorker();
    handlers.failed!(job(1), new Error('buildkitd unreachable'));
    await settle();
    expect(failSubmissionPipeline).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Submission gate run failed', expect.objectContaining({ submissionId: 'sub-1', attempt: 1 }));
  });

  it('the TERMINAL failure fails the submission closed with the error', async () => {
    q.startSubmissionWorker();
    handlers.failed!(job(3), new Error('buildkitd unreachable'));
    await settle();
    expect(failSubmissionPipeline).toHaveBeenCalledWith('sub-1', 'buildkitd unreachable');
  });

  it('falls back to the default attempt budget when the job carries none', async () => {
    q.startSubmissionWorker();
    handlers.failed!(job(2, undefined), new Error('x'));
    await settle();
    expect(failSubmissionPipeline).not.toHaveBeenCalled();
    handlers.failed!(job(3, undefined), new Error('x'));
    await settle();
    expect(failSubmissionPipeline).toHaveBeenCalledTimes(1);
  });

  it('logs (never throws) when failing the submission closed itself fails', async () => {
    failSubmissionPipeline.mockRejectedValueOnce(new Error('db down'));
    q.startSubmissionWorker();
    handlers.failed!(job(3), new Error('boom'));
    await settle();
    expect(logger.error).toHaveBeenCalledWith('Could not fail a stuck submission closed', { submissionId: 'sub-1', error: 'db down' });
  });

  it('ignores a failed event without a job, and logs worker errors', () => {
    q.startSubmissionWorker();
    expect(() => handlers.failed!(undefined, new Error('x'))).not.toThrow();
    handlers.error!(new Error('redis gone'));
    expect(logger.error).toHaveBeenCalledWith('Submission worker error', { error: 'redis gone' });
    expect(failSubmissionPipeline).not.toHaveBeenCalled();
  });
});

describe('shutdown', () => {
  it('closes the worker and the queue, and is safe to call when nothing started', async () => {
    await q.enqueueSubmissionBuild('sub-1');
    q.startSubmissionWorker();
    await q.shutdownSubmissionQueue();
    expect(workerClose).toHaveBeenCalledTimes(1);
    expect(queueClose).toHaveBeenCalledTimes(1);
    await q.shutdownSubmissionQueue();
    expect(workerClose).toHaveBeenCalledTimes(1);
  });
});
