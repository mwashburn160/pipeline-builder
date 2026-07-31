// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import { createLogger, sendError, ErrorCode } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import type { Request, Response, NextFunction } from 'express';

const logger = createLogger('idempotency');

/**
 * Canonical (key-sorted) JSON serialization so the SAME logical payload hashes
 * identically regardless of property insertion order — a plain `JSON.stringify`
 * would let `{a,b}` and `{b,a}` produce different fingerprints for one request.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/**
 * Short, stable fingerprint of a request body. Folds the payload into the
 * idempotency key so replaying the SAME key with a DIFFERENT body is treated as
 * a distinct operation (fresh execution) rather than replaying the old response.
 * Empty/absent bodies collapse to '-' so body-less mutations stay unaffected.
 */
function bodyFingerprint(body: unknown): string {
  if (body === undefined || body === null) return '-';
  if (typeof body === 'object' && Object.keys(body as object).length === 0) return '-';
  try {
    return createHash('sha256').update(stableStringify(body)).digest('hex').slice(0, 16);
  } catch {
    // Non-serializable body (e.g. a stream/circular ref): skip fingerprinting
    // rather than fail the request — key stays scoped by method+route+org.
    return '-';
  }
}

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
 * Defaults to an in-memory store (single-replica). Pass a custom
 * cross-replica `{ store }` implementing `IdempotencyStore` to dedupe across
 * replicas.
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

    // Namespace the stored key by (method, route, org, body) so an Idempotency-Key
    // is scoped to ONE specific endpoint+payload. Reusing a single key across two
    // routes (e.g. POST /pipelines then POST /plugins) previously replayed the
    // first endpoint's 2xx for the second — the store is a module-level singleton
    // shared by every route. Folding in method + route path + a body fingerprint
    // only makes keys MORE specific, so there is no cross-contamination risk.
    const routePath = (req.baseUrl ?? '') + (req.route?.path ?? req.path ?? '');
    const fullKey = `${req.method}:${routePath}:${orgId}:${bodyFingerprint(req.body)}:${key}`;

    /** Reject a duplicate whose original is still in-flight. */
    const sendInProgress = (): void => {
      res.setHeader('Retry-After', '1');
      sendError(res, 409, 'A request with this Idempotency-Key is already being processed', ErrorCode.CONFLICT);
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

      // We own the reservation. It MUST be resolved exactly once — either the
      // real 2xx response is cached for replay, or the reservation is released so
      // a retry can proceed. `settled` guards against a double-resolve.
      let settled = false;
      let capturedBody: unknown;
      let bodyCaptured = false;

      /** Remember the response body for replay (first capture wins). */
      const captureBody = (body: unknown): void => {
        if (!bodyCaptured) {
          capturedBody = body;
          bodyCaptured = true;
        }
      };

      const release = (): void => {
        if (settled) return;
        settled = true;
        store.delete(fullKey).catch((err) => {
          logger.warn('Idempotency reservation release failed', { key: fullKey, error: err instanceof Error ? err.message : String(err) });
        });
      };

      const cacheSuccess = (): void => {
        if (settled) return;
        settled = true;
        store.set(fullKey, {
          statusCode: res.statusCode,
          body: bodyCaptured ? capturedBody : null,
          expiresAt: Date.now() + ttlMs,
        }, ttlSec).catch((err) => {
          logger.warn('Idempotency store.set failed', { key: fullKey, error: err instanceof Error ? err.message : String(err) });
        });
      };

      /** Resolve the reservation from the ACTUAL final status: cache 2xx, else release. */
      const settleFromStatus = (): void => {
        if (settled) return;
        if (res.statusCode >= 200 && res.statusCode < 300) cacheSuccess();
        else release();
      };

      // Fast path: res.json is the common completion. Capture the body and settle
      // immediately off the status set by res.status(...).json(...).
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        res.setHeader('X-Idempotent-Replayed', 'false');
        captureBody(body);
        settleFromStatus();
        return originalJson(body);
      };

      // Body-capture backstops for completions that bypass res.json
      // (res.send / res.end / res.sendFile → res.end). These only RECORD the body;
      // the actual settle happens on `finish` from the real status code. First
      // capture wins, so res.json's body is never clobbered by its internal
      // res.send/res.end calls.
      const patched = res as unknown as {
        send?: (body?: unknown) => unknown;
        end?: (...args: unknown[]) => unknown;
        on?: (event: string, cb: () => void) => unknown;
      };
      if (typeof patched.send === 'function') {
        const originalSend = patched.send.bind(res);
        patched.send = (body?: unknown) => {
          captureBody(body);
          return originalSend(body);
        };
      }
      if (typeof patched.end === 'function') {
        const originalEnd = patched.end.bind(res);
        patched.end = (...args: unknown[]) => {
          const chunk = args[0];
          if (chunk !== undefined && typeof chunk !== 'function') captureBody(chunk);
          return originalEnd(...args);
        };
      }

      // Backstop for ANY completion path — including a 2xx that finished via
      // res.send/res.end/res.sendFile/204 and never hit the patched res.json.
      // Deciding on the real final status here means a successful op is cached
      // (or a failed one released) instead of stranding the reservation and
      // 409-ing every retry for the full TTL. Guarded — test doubles may not be
      // EventEmitters; res.json's fast path already settled the common case.
      if (typeof patched.on === 'function') {
        patched.on('finish', settleFromStatus);
      }

      next();
    }).catch((err) => {
      // If the store backend is down, fail open — process the request normally.
      logger.warn('Idempotency store.get failed; proceeding without dedup', { key: fullKey, error: err instanceof Error ? err.message : String(err) });
      next();
    });
  };
}
