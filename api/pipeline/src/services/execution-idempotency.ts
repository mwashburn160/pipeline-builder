// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createEnvRedisClient, createLogger } from '@pipeline-builder/api-core';

const logger = createLogger('execution-idempotency');

/**
 * Short server-side idempotency window for the AWS CodePipeline trigger.
 *
 * A double-submit (double-click, an over-eager client retry, an SQS-style
 * redelivery) must NOT start two CodePipeline executions for the same pipeline.
 * `StartPipelineExecution` is not naturally idempotent — every call spins up a
 * fresh run — so we serialize triggers per (orgId, pipelineId) for a short
 * window using an atomic Redis `SET … NX`. The FIRST trigger in the window
 * claims the key; a second within the window is refused so the caller can be
 * 409'd instead of launching a duplicate run.
 *
 * Overridable via `PIPELINE_EXEC_IDEMPOTENCY_WINDOW_SECONDS`; short by design so
 * a genuine re-run (a real second execution the user wants) isn't blocked for
 * long.
 */
const DEFAULT_WINDOW_SECONDS = 10;

function resolveWindowSeconds(): number {
  const raw = process.env.PIPELINE_EXEC_IDEMPOTENCY_WINDOW_SECONDS;
  if (!raw) return DEFAULT_WINDOW_SECONDS;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_WINDOW_SECONDS;
  return parsed;
}

/**
 * Minimal Redis surface the guard needs (an ioredis subset). `set` supports the
 * variadic option tail `SET key val EX <ttl> NX`, returning `'OK'` on success
 * and `null` when the `NX` set was refused (key already present).
 */
export interface ExecIdemRedis {
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(key: string): Promise<number>;
}

export interface ExecutionIdempotencyGuard {
  /**
   * Try to claim the execution window for (orgId, pipelineId). Returns `true`
   * when THIS caller claimed it (no trigger within the window → proceed);
   * `false` when a trigger is already in-window (→ the caller should 409 rather
   * than start a duplicate run). FAILS OPEN (returns `true`) when Redis is
   * unconfigured or unreachable — single-replica deploys keep working, and a
   * transient Redis outage never blocks a legitimate trigger.
   */
  claim(orgId: string, pipelineId: string): Promise<boolean>;
  /**
   * Release a previously-claimed window so a legitimate retry isn't blocked for the
   * full TTL after a FAILED trigger (the claim is taken before the AWS call; if that
   * call errors the run never started, so the window should reopen immediately).
   * Best-effort — a Redis error is swallowed (TTL is the backstop).
   */
  release(orgId: string, pipelineId: string): Promise<void>;
}

const REDIS_KEY_PREFIX = 'pipeline-exec:';

/** Build a guard over an explicit Redis client (or `null` → always fail-open). */
export function createExecutionIdempotencyGuard(
  redis: ExecIdemRedis | null,
  windowSeconds: number = resolveWindowSeconds(),
): ExecutionIdempotencyGuard {
  const ttl = Math.max(1, windowSeconds);
  return {
    async claim(orgId, pipelineId) {
      if (!redis) return true; // No Redis → no cross-pod dedup; fail open.
      const key = `${REDIS_KEY_PREFIX}${orgId}:${pipelineId}`;
      try {
        const res = await redis.set(key, '1', 'EX', ttl, 'NX');
        // 'OK' → we set it (window was free). null → an entry already exists.
        return res === 'OK';
      } catch (err) {
        // Redis hiccup: fail OPEN so a transient outage doesn't reject triggers.
        logger.warn('Execution idempotency claim failed; proceeding without dedup', {
          error: err instanceof Error ? err.message : String(err),
        });
        return true;
      }
    },
    async release(orgId, pipelineId) {
      if (!redis) return;
      try {
        await redis.del(`${REDIS_KEY_PREFIX}${orgId}:${pipelineId}`);
      } catch (err) {
        // TTL is the backstop — a failed release just means the window closes late.
        logger.warn('Execution idempotency release failed; window will expire via TTL', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/** Build the guard from the shared env Redis (same wiring as the other stores). */
function createEnvExecutionIdempotencyGuard(): ExecutionIdempotencyGuard {
  const client = createEnvRedisClient<ExecIdemRedis>('execution-idempotency');
  if (client) logger.info('Redis execution-idempotency guard initialized');
  return createExecutionIdempotencyGuard(client);
}

/** Process-wide singleton the trigger route consumes. */
export const executionIdempotency = createEnvExecutionIdempotencyGuard();
