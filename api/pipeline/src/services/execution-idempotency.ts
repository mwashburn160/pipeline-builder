// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { createEnvRedisClient, createLogger, errorMessage } from '@pipeline-builder/api-core';

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
  /** Lua, for the owner-only release (compare-and-delete). */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Delete the window only if it still holds OUR token. */
const RELEASE_IF_OWNER =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/**
 * A claimed window. `token` identifies THIS claim, so releasing it can never
 * free a window a later trigger claimed after ours expired. `null` token = no
 * Redis (nothing to release).
 */
export interface ExecutionClaim {
  token: string | null;
}

export interface ExecutionIdempotencyGuard {
  /**
   * Try to claim the execution window for (orgId, pipelineId). Returns the
   * claim when THIS caller took it (no trigger within the window → proceed);
   * `null` when a trigger is already in-window (→ the caller should 409 rather
   * than start a duplicate run). FAILS OPEN (a token-less claim) when Redis is
   * unconfigured or unreachable — single-replica deploys keep working, and a
   * transient Redis outage never blocks a legitimate trigger.
   */
  claim(orgId: string, pipelineId: string): Promise<ExecutionClaim | null>;
  /**
   * Release a claimed window so a legitimate retry isn't blocked for the full
   * TTL after a trigger that DEFINITELY did not start a run (the pipeline isn't
   * registered / doesn't exist in AWS). Never call it after an ambiguous failure
   * (a network timeout, an AWS 5xx): the run may have started, and reopening the
   * window is exactly what lets the retry launch a duplicate. Owner-only
   * (compare-and-delete on the claim's token); best-effort — TTL is the backstop.
   */
  release(orgId: string, pipelineId: string, claim: ExecutionClaim): Promise<void>;
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
      if (!redis) return { token: null }; // No Redis → no cross-pod dedup; fail open.
      const key = `${REDIS_KEY_PREFIX}${orgId}:${pipelineId}`;
      const token = randomUUID();
      try {
        const res = await redis.set(key, token, 'EX', ttl, 'NX');
        // 'OK' → we set it (window was free). null → an entry already exists.
        return res === 'OK' ? { token } : null;
      } catch (err) {
        // Redis hiccup: fail OPEN so a transient outage doesn't reject triggers.
        logger.warn('Execution idempotency claim failed; proceeding without dedup', {
          error: errorMessage(err),
        });
        return { token: null };
      }
    },
    async release(orgId, pipelineId, claim) {
      if (!redis || !claim.token) return;
      try {
        await redis.eval(RELEASE_IF_OWNER, 1, `${REDIS_KEY_PREFIX}${orgId}:${pipelineId}`, claim.token);
      } catch (err) {
        // TTL is the backstop — a failed release just means the window closes late.
        logger.warn('Execution idempotency release failed; window will expire via TTL', {
          error: errorMessage(err),
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
