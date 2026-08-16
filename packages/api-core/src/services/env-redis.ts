// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'module';

import { createLogger } from '../utils/logger.js';

const logger = createLogger('env-redis');

/**
 * Parse `REDIS_SENTINELS` (comma-separated `host:port` list) into the ioredis
 * `{ host, port }[]` sentinel array. Blank/garbage entries are skipped; a
 * missing port defaults to the Sentinel default 26379. Returns an empty array
 * when the env is unset/empty (→ non-sentinel mode).
 */
export function parseSentinels(raw: string | undefined): Array<{ host: string; port: number }> {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [host, port] = entry.split(':');
    return { host, port: parseInt(port ?? '26379', 10) || 26379 };
  }).filter((s) => !!s.host);
}

/**
 * Construct an ioredis client from the standard `REDIS_URL` or
 * `REDIS_HOST`/`REDIS_PORT` env — OR, for HA, from Redis Sentinel via
 * `REDIS_SENTINELS` + `REDIS_SENTINEL_MASTER`. The shared construction was
 * previously duplicated across the leader-lock, audit-spool, and
 * token-revocation env factories.
 *
 * Connection modes (first that matches wins):
 * 1. SENTINEL — `REDIS_SENTINELS` set (comma-separated `host:port`): ioredis
 *    resolves the current master from the sentinels (`name` = `REDIS_SENTINEL_MASTER`,
 *    default `mymaster`) and transparently reconnects to the new master after a
 *    failover. This is how the app gets HA against a single-node Redis loss —
 *    also the shape a managed ElastiCache (cluster-mode-disabled) speaks.
 * 2. URL — `REDIS_URL`.
 * 3. HOST/PORT — `REDIS_HOST`(+`REDIS_PORT`).
 *
 * Semantics every caller relies on (kept identical across the consolidation):
 * - Returns `null` when NONE of sentinels/url/host is set, so a caller degrades
 *   to its no-Redis fallback (run-on-every-pod / best-effort / fail-open).
 * - FAIL-SAFE: any ioredis load or construction error is swallowed and returns
 *   `null` — Redis being unavailable must never crash the importing service.
 * - `ioredis` is a runtime-only optional dep loaded via `createRequire`, so this
 *   module stays importable in CJS bundles and where Redis isn't installed.
 * - `maxRetriesPerRequest: 1` + `enableOfflineQueue: false`: commands fail fast
 *   rather than queueing during an outage (callers are fail-open/best-effort).
 * - An `error` listener is attached (ioredis auto-reconnects) so a dropped
 *   connection can't surface as an unhandled `'error'` event that crashes Node.
 *
 * Optional auth: `REDIS_PASSWORD` (data-node AUTH) and `REDIS_SENTINEL_PASSWORD`
 * (sentinel AUTH, sentinel mode only) are threaded through when set.
 *
 * @param label short human name for this client, used in the two warn logs.
 */
export function createEnvRedisClient<T = unknown>(label: string): T | null {
  try {
    const sentinels = parseSentinels(process.env.REDIS_SENTINELS);
    const url = process.env.REDIS_URL;
    const host = process.env.REDIS_HOST;
    if (sentinels.length === 0 && !url && !host) return null;
    const req = createRequire(import.meta.url);
    const mod = req('ioredis') as {
      Redis?: new (...args: unknown[]) => unknown;
      default?: new (...args: unknown[]) => unknown;
    };
    const RedisCtor = (mod.Redis ?? mod.default ?? mod) as new (...args: unknown[]) => T;
    const redisOpts: Record<string, unknown> = { maxRetriesPerRequest: 1, enableOfflineQueue: false };
    if (process.env.REDIS_PASSWORD) redisOpts.password = process.env.REDIS_PASSWORD;

    let inst: T;
    if (sentinels.length > 0) {
      // Sentinel mode: ioredis tracks the master via the sentinels + auto-fails-over.
      const sentinelOpts: Record<string, unknown> = {
        sentinels,
        name: process.env.REDIS_SENTINEL_MASTER || 'mymaster',
        ...redisOpts,
      };
      if (process.env.REDIS_SENTINEL_PASSWORD) sentinelOpts.sentinelPassword = process.env.REDIS_SENTINEL_PASSWORD;
      inst = new RedisCtor(sentinelOpts);
      logger.info(`Redis ${label}: Sentinel mode`, { master: sentinelOpts.name, sentinels: sentinels.length });
    } else if (url) {
      inst = new RedisCtor(url, redisOpts);
    } else {
      inst = new RedisCtor({ host, port: parseInt(process.env.REDIS_PORT ?? '6379', 10), ...redisOpts });
    }
    (inst as unknown as { on: (evt: string, cb: (e: unknown) => void) => void })
      .on('error', (e) => logger.warn(`Redis ${label} client error`, { error: e instanceof Error ? e.message : String(e) }));
    return inst;
  } catch (err) {
    logger.warn(`Redis unavailable for ${label}`, { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
