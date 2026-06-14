// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import type { Request, Response, NextFunction } from 'express';

const logger = createLogger('idempotency');

interface CachedEntry {
  statusCode: number;
  body: unknown;
  expiresAt: number;
  /** Reservation placeholder: the request is in-flight, no real response yet.
   *  A duplicate that sees a pending entry is rejected with 409, not replayed. */
  pending?: boolean;
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
  /**
   * Atomically claim `key` IFF it is currently absent. Returns `true` when THIS
   * caller set the entry (won the race), `false` when an entry already exists.
   * This is what serializes concurrent first-time requests that share an
   * Idempotency-Key — a plain get-then-set leaves a window where two requests
   * both see "not cached" and both execute the mutation.
   */
  reserve(key: string, entry: CachedEntry, ttlSeconds: number): Promise<boolean>;
  /** Remove a key — releases a reservation after a non-cacheable (non-2xx) response. */
  delete(key: string): Promise<void>;
}

/**
 * Minimal interface a Redis client must satisfy. Compatible with
 * `ioredis` and `redis` v4+ — both expose `get`/`set` and accept `EX`
 * for expiry. Pass your real client in via `idempotencyMiddleware({
 * store: createRedisIdempotencyStore(client) })`.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  // Variadic to fit ioredis (`set(k, v, 'EX', ttl, 'NX')`) — `reserve` needs the
  // `NX` flag for an atomic set-if-absent, which the fixed 4-arg form can't express.
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del?(key: string): Promise<unknown>;
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
    async reserve(key, entry, ttlSeconds) {
      // SET key val EX ttl NX — atomic across replicas. Redis returns 'OK' when
      // it set the key and null when the key already existed.
      const res = await client.set(prefix + key, JSON.stringify(entry), 'EX', ttlSeconds, 'NX');
      return res !== null && res !== undefined;
    },
    async delete(key) {
      if (client.del) await client.del(prefix + key);
    },
  };
}

/** Default in-memory store. Single-replica only. Exported for testing. */
export function createMemoryStore(): IdempotencyStore {
  const map = new Map<string, CachedEntry>();
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of map) {
      if (now > v.expiresAt) map.delete(k);
    }
  }, CoreConstants.IDEMPOTENCY_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  /** Return the live (non-expired) entry, evicting it lazily if expired. */
  const live = (key: string): CachedEntry | null => {
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      map.delete(key);
      return null;
    }
    return entry;
  };
  /**
   * At capacity, evict the OLDEST entry (Map preserves insertion order) rather
   * than silently dropping the NEW key — otherwise, once full, the store stops
   * deduplicating fresh requests until the TTL sweep runs. Stays bounded; favors
   * recent keys (most likely to be retried).
   */
  const evictIfFull = (key: string): void => {
    if (!map.has(key) && map.size >= CoreConstants.IDEMPOTENCY_MAX_STORE_SIZE) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  };
  return {
    async get(key) {
      return live(key);
    },
    async set(key, entry) {
      evictIfFull(key);
      map.set(key, entry);
    },
    async reserve(key, entry) {
      // Atomic in a single-threaded runtime: no await between the liveness check
      // and the set, so two concurrent callers can't both observe "absent".
      if (live(key)) return false;
      evictIfFull(key);
      map.set(key, entry);
      return true;
    },
    async delete(key) {
      map.delete(key);
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
  const ttlMs = CoreConstants.IDEMPOTENCY_TTL_MS;
  const ttlSec = Math.floor(ttlMs / 1000);

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key) return next();

    // Only apply to mutation methods
    if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();

    // Namespace by orgId to prevent cross-org cache collisions. Prefer the
    // VERIFIED auth org (`req.user`, populated by requireAuth after signature
    // verification) over `req.context.identity`, which some services populate
    // pre-auth from an UNVERIFIED token peek — namespacing a mutation's replay
    // cache on an unverified, caller-influenced org id would be unsafe.
    const orgId = req.user?.organizationId || req.context?.identity?.orgId;
    if (!orgId) return next(); // skip idempotency for unauthenticated requests
    const fullKey = `${orgId}:${key}`;

    /** Reject a duplicate whose original is still in-flight. */
    const sendInProgress = (): void => {
      res.setHeader('Retry-After', '1');
      res.status(409).json({
        success: false,
        error: 'A request with this Idempotency-Key is already being processed',
      });
    };

    store.get(fullKey).then(async (cached) => {
      if (cached && !cached.pending) {
        // Completed response on record → replay it.
        logger.debug('Idempotent request replayed', { key: fullKey });
        res.setHeader('X-Idempotent-Replayed', 'true');
        res.status(cached.statusCode).json(cached.body);
        return;
      }
      if (cached && cached.pending) {
        // The original is still running — don't run the mutation a second time.
        logger.debug('Idempotent request rejected (in progress)', { key: fullKey });
        return sendInProgress();
      }

      // Atomically reserve the key. Losing this race means a concurrent request
      // with the same key got there first and is in-flight → 409.
      const won = await store.reserve(
        fullKey,
        { statusCode: 0, body: null, pending: true, expiresAt: Date.now() + ttlMs },
        ttlSec,
      );
      if (!won) {
        logger.debug('Idempotent request rejected (lost reserve race)', { key: fullKey });
        return sendInProgress();
      }

      // We own the reservation. Replace it with the real response on completion;
      // a non-2xx response RELEASES the reservation so a retry can proceed.
      let settled = false;
      const release = (): void => {
        if (settled) return;
        settled = true;
        store.delete(fullKey).catch((err) => {
          logger.warn('Idempotency reservation release failed', { key: fullKey, error: err instanceof Error ? err.message : String(err) });
        });
      };

      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        res.setHeader('X-Idempotent-Replayed', 'false');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          settled = true; // the finish-net must not delete a cached success
          store.set(fullKey, {
            statusCode: res.statusCode,
            body,
            expiresAt: Date.now() + ttlMs,
          }, ttlSec).catch((err) => {
            logger.warn('Idempotency store.set failed', { key: fullKey, error: err instanceof Error ? err.message : String(err) });
          });
        } else {
          release();
        }
        return originalJson(body);
      };

      // Safety net for response paths that bypass res.json (res.send/res.end,
      // an error handler, a thrown request): if the response finishes non-2xx
      // with the reservation still held, release it so retries aren't blocked
      // for the full TTL. Guarded — test doubles may not be EventEmitters.
      if (typeof (res as { on?: unknown }).on === 'function') {
        res.on('finish', () => {
          if (!(res.statusCode >= 200 && res.statusCode < 300)) release();
        });
      }

      next();
    }).catch((err) => {
      // If the store backend is down, fail open — process the request normally.
      logger.warn('Idempotency store.get failed; proceeding without dedup', { key: fullKey, error: err instanceof Error ? err.message : String(err) });
      next();
    });
  };
}
