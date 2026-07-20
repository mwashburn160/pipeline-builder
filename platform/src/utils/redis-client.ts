// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lazily-constructed Redis client accessor for the platform.
 *
 * Platform is otherwise fully Mongo-backed and has no long-lived Redis client;
 * the ONE thing it needs Redis for is PUBLISHING session-revocation entries that
 * the stateless services read (see helpers/session-revocation.ts). Rather than
 * standing up a full CacheService, we expose a single memoized accessor that
 * builds an ioredis client from `config.redis.url` on first use.
 *
 * Convention mirrors api-server's app-factory: a guarded dynamic `require`
 * (ioredis isn't a static import), an `error` listener so a dropped connection
 * can't crash the process (ioredis auto-reconnects), and graceful degradation —
 * when no URL is configured (or ioredis can't be loaded) the accessor returns
 * `undefined` and the publisher simply falls back to natural token expiry.
 *
 * `config` is imported LAZILY (dynamic import inside the guard): merely importing
 * this module — as every instrumented service does transitively — must never
 * force evaluation of the config module (which requires prod env like
 * MONGODB_URI). A config-load failure is swallowed like any other and yields the
 * no-op path.
 */

import { createRequire } from 'module';
import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import type { RedisCacheClient } from '@pipeline-builder/api-core';

const logger = createLogger('redis-client');

/**
 * Memoized accessor state:
 * - `undefined`  → not yet attempted (build on first call)
 * - `null`       → attempted and unavailable (no URL / load failure) — stay off
 * - a client     → live ioredis instance
 */
let cached: RedisCacheClient | null | undefined;

/**
 * Return the shared Redis client, or `undefined` when Redis is not configured /
 * unavailable. Never throws — a missing or broken Redis degrades to a no-op for
 * the (best-effort) session-revocation publisher.
 */
export async function getRedisClient(): Promise<RedisCacheClient | undefined> {
  if (cached !== undefined) return cached ?? undefined;

  try {
    // Lazy: don't drag the (prod-env-requiring) config module into this file's
    // static import graph — it's transitively imported by many unit-tested services.
    const { config } = await import('../config/index.js');
    const url = config.redis?.url;
    if (!url) {
      // No Redis configured — record the decision so we don't re-check every call.
      cached = null;
      return undefined;
    }

    // Dynamic require (ioredis is a runtime-only dep, not a static import) so the
    // module load can't break builds/tests where Redis isn't present.
    const require = createRequire(import.meta.url);
    const mod = require('ioredis') as {
      Redis?: new (url: string, opts?: unknown) => unknown;
      default?: new (url: string, opts?: unknown) => unknown;
    };
    const RedisCtor = (mod.Redis ?? mod.default ?? mod) as new (url: string, opts?: unknown) => RedisCacheClient;
    const client = new RedisCtor(url, {
      // Keep single, fire-and-forget SETs from blocking the request path.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    // ioredis emits 'error' on connection loss; without a listener Node treats it
    // as an unhandled error. Log + let ioredis auto-reconnect.
    (client as unknown as { on: (evt: string, cb: (e: unknown) => void) => void })
      .on('error', (e) => logger.warn('Redis client error', { error: errorMessage(e) }));
    cached = client;
    logger.info('Redis client initialized for session-revocation publishing');
    return cached;
  } catch (err) {
    logger.warn('Redis unavailable; session revocation will fall back to token expiry', {
      error: errorMessage(err),
    });
    cached = null;
    return undefined;
  }
}

/** Test-only: reset the memoized client so a suite can re-exercise construction. */
export function __resetRedisClientForTests(): void {
  cached = undefined;
}
