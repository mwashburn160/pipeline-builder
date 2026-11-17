// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Short per-job Redis lock serializing operator re-runs of one dead build.
 * A retry (tier `failed` set) or replay (DLQ) is check-then-enqueue — look the
 * job up, reserve a quota slot, enqueue, drop the source — which is not atomic
 * on its own: two concurrent calls could both see the job and both re-enqueue
 * it. The whole sequence therefore runs under this lock, and a call that finds
 * it held is refused with a 409 `CONFLICT` before anything is reserved or queued.
 */

import { randomUUID } from 'node:crypto';

import { AppError, createLogger, ErrorCode, errorMessage } from '@pipeline-builder/api-core';

import { getConnectionForDb } from './connections.js';

const logger = createLogger('plugin-build-queue');

/** Which operator re-run the lock guards (part of the key). */
export type JobLockKind = 'retry' | 'replay';

/** How long a per-job lock lives if its holder dies before releasing it. */
export const JOB_LOCK_TTL_MS = 30_000;

/** Delete the lock only when it still holds OUR token (an expired-then-retaken lock is someone else's). */
const RELEASE_LOCK_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** The Redis key of a per-job lock: queue-qualified, as job ids repeat across tier queues. */
export function jobLockKey(kind: JobLockKind, queueName: string, jobId: string): string {
  return `plugin-build:${kind}-lock:${queueName}:${jobId}`;
}

/** A re-run refused because another of the same kind holds the job's lock. */
class JobLockConflictError extends AppError {
  constructor(kind: JobLockKind) {
    super(409, ErrorCode.CONFLICT, `A ${kind} of this build is already in progress.`);
    this.name = 'JobLockConflictError';
  }
}

/**
 * Run `fn` holding the per-job `kind` lock (`SET NX PX` on the db-0
 * connection). Throws a 409 `CONFLICT` {@link AppError} without calling `fn`
 * when the lock is held; otherwise releases it (compare-and-delete) once `fn`
 * settles, whether it resolved or threw. A failed release is only logged — the
 * lock then expires on its TTL.
 */
export async function withJobLock<T>(kind: JobLockKind, queueName: string, jobId: string, fn: () => Promise<T>): Promise<T> {
  const redis = getConnectionForDb(0);
  const key = jobLockKey(kind, queueName, jobId);
  const token = randomUUID();
  const ok = await redis.set(key, token, 'PX', JOB_LOCK_TTL_MS, 'NX');
  if (ok !== 'OK') throw new JobLockConflictError(kind);
  try {
    return await fn();
  } finally {
    try {
      await redis.eval(RELEASE_LOCK_LUA, 1, key, token);
    } catch (err) {
      logger.warn(`Could not release the build ${kind} lock; it expires on its TTL`, { jobId, error: errorMessage(err) });
    }
  }
}
