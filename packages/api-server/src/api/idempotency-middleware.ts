// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Request, Response, NextFunction } from 'express';

const logger = createLogger('Idempotency');

interface CachedEntry {
  statusCode: number;
  body: unknown;
  expiresAt: number;
}

/**
 * Pluggable backend for idempotency-key replay cache. The default in-memory
 * implementation works fine single-replica; a Redis-backed implementation
 * is required for correct deduplication across horizontally-scaled replicas
 * (otherwise two replicas behind a load-balancer cache independently and a
 * retry hitting a different pod won't replay).
 */
export interface IdempotencyStore {
  get(key: string): Promise<CachedEntry | null>;
  set(key: string, entry: CachedEntry, ttlSeconds: number): Promise<void>;
}

/**
 * Minimal interface a Redis client must satisfy. Compatible with
 * `ioredis` and `redis` v4+ — both expose `get`/`set` and accept `EX`
 * for expiry. Pass your real client in via `idempotencyMiddleware({
 * store: createRedisIdempotencyStore(client) })`.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: 'EX', seconds?: number): Promise<unknown>;
}

/** Redis-backed idempotency store — share state across replicas. */
export function createRedisIdempotencyStore(client: RedisLike, prefix = 'idemp:'): IdempotencyStore {
  return {
    async get(key) {
      const raw = await client.get(prefix + key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as CachedEntry;
      } catch {
        return null;
      }
    },
    async set(key, entry, ttlSeconds) {
      await client.set(prefix + key, JSON.stringify(entry), 'EX', ttlSeconds);
    },
  };
}

/** Default in-memory store. Single-replica only. */
function createMemoryStore(): IdempotencyStore {
  const map = new Map<string, CachedEntry>();
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of map) {
      if (now > v.expiresAt) map.delete(k);
    }
  }, CoreConstants.IDEMPOTENCY_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
  return {
    async get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        map.delete(key);
        return null;
      }
      return entry;
    },
    async set(key, entry) {
      if (map.size >= CoreConstants.IDEMPOTENCY_MAX_STORE_SIZE) return;
      map.set(key, entry);
    },
  };
}

const memoryStore = createMemoryStore();

export interface IdempotencyMiddlewareOptions {
  /** Custom store backend (default: in-memory). Pass a Redis-backed store
   *  for multi-replica deployments. */
  store?: IdempotencyStore;
}

/**
 * Middleware that supports idempotency keys for POST/PUT/DELETE mutations.
 *
 * When a request includes the `Idempotency-Key` header:
 * - First call: processes normally, caches the response
 * - Subsequent calls with same key: returns cached response (prevents duplicate mutations)
 *
 * Pass `{ store: createRedisIdempotencyStore(redisClient) }` to dedupe
 * across replicas.
 */
export function idempotencyMiddleware(options: IdempotencyMiddlewareOptions = {}) {
  const store = options.store ?? memoryStore;
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key) return next();

    // Only apply to mutation methods
    if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();

    // Namespace by orgId to prevent cross-org cache collisions
    const orgId = req.context?.identity?.orgId || req.user?.organizationId;
    if (!orgId) return next(); // skip idempotency for unauthenticated requests
    const fullKey = `${orgId}:${key}`;

    // Check for cached response
    store.get(fullKey).then((cached) => {
      if (cached) {
        logger.debug('Idempotent request replayed', { key: fullKey });
        res.setHeader('X-Idempotent-Replayed', 'true');
        res.status(cached.statusCode).json(cached.body);
        return;
      }

      // Intercept res.json to cache the response
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        res.setHeader('X-Idempotent-Replayed', 'false');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Fire-and-forget — failure to cache is logged but doesn't block the response.
          store.set(fullKey, {
            statusCode: res.statusCode,
            body,
            expiresAt: Date.now() + CoreConstants.IDEMPOTENCY_TTL_MS,
          }, Math.floor(CoreConstants.IDEMPOTENCY_TTL_MS / 1000)).catch((err) => {
            logger.warn('Idempotency store.set failed', { key: fullKey, error: err instanceof Error ? err.message : String(err) });
          });
        }
        return originalJson(body);
      };

      next();
    }).catch((err) => {
      // If the store backend is down, fail open — process the request normally.
      logger.warn('Idempotency store.get failed; proceeding without dedup', { key: fullKey, error: err instanceof Error ? err.message : String(err) });
      next();
    });
  };
}
