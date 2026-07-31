// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'module';

import { createLogger } from '../utils/logger.js';

const logger = createLogger('env-redis');

/**
 * Construct an ioredis client from the standard `REDIS_URL` or
 * `REDIS_HOST`/`REDIS_PORT` env — the shared construction previously duplicated
 * across the leader-lock, audit-spool, and token-revocation env factories.
 *
 * Semantics every caller relies on (kept identical across the consolidation):
 * - Returns `null` when neither `REDIS_URL` nor `REDIS_HOST` is set, so a caller
 *   degrades to its no-Redis fallback (run-on-every-pod / best-effort / fail-open).
 * - FAIL-SAFE: any ioredis load or construction error is swallowed and returns
 *   `null` — Redis being unavailable must never crash the importing service.
 * - `ioredis` is a runtime-only optional dep loaded via `createRequire`, so this
 *   module stays importable in CJS bundles and where Redis isn't installed.
 * - `maxRetriesPerRequest: 1` + `enableOfflineQueue: false`: commands fail fast
 *   rather than queueing during an outage (callers are fail-open/best-effort).
 * - An `error` listener is attached (ioredis auto-reconnects) so a dropped
 *   connection can't surface as an unhandled `'error'` event that crashes Node.
 *
 * @param label short human name for this client, used in the two warn logs.
 */
export function createEnvRedisClient<T = unknown>(label: string): T | null {
  try {
    const url = process.env.REDIS_URL;
    const host = process.env.REDIS_HOST;
    if (!url && !host) return null;
    const req = createRequire(import.meta.url);
    const mod = req('ioredis') as {
      Redis?: new (...args: unknown[]) => unknown;
      default?: new (...args: unknown[]) => unknown;
    };
    const RedisCtor = (mod.Redis ?? mod.default ?? mod) as new (...args: unknown[]) => T;
    const redisOpts = { maxRetriesPerRequest: 1, enableOfflineQueue: false };
    const inst = url
      ? new RedisCtor(url, redisOpts)
      : new RedisCtor({ host, port: parseInt(process.env.REDIS_PORT ?? '6379', 10), ...redisOpts });
    (inst as unknown as { on: (evt: string, cb: (e: unknown) => void) => void })
      .on('error', (e) => logger.warn(`Redis ${label} client error`, { error: e instanceof Error ? e.message : String(e) }));
    return inst;
  } catch (err) {
    logger.warn(`Redis unavailable for ${label}`, { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
