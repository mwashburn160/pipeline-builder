import { createLogger } from '@mwashburn160/api-core';
import { CoreConstants } from '@mwashburn160/pipeline-core';
import { Request, Response, NextFunction } from 'express';

const logger = createLogger('Idempotency');

/** In-memory store for idempotency results (TTL-based). */
const store = new Map<string, { statusCode: number; body: unknown; expiresAt: number }>();

// Periodic cleanup of expired entries
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) store.delete(key);
  }
}, CoreConstants.IDEMPOTENCY_CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

/**
 * Middleware that supports idempotency keys for POST/PUT/DELETE mutations.
 *
 * When a request includes the `Idempotency-Key` header:
 * - First call: processes normally, caches the response
 * - Subsequent calls with same key: returns cached response (prevents duplicate mutations)
 */
export function idempotencyMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key) return next();

    // Only apply to mutation methods
    if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();

    // Namespace by orgId to prevent cross-org collisions
    const orgId = (req as any).orgId || (req as any).identity?.orgId || 'anon';
    const fullKey = `${orgId}:${key}`;

    // Check for cached response
    const cached = store.get(fullKey);
    if (cached && Date.now() < cached.expiresAt) {
      logger.debug('Idempotent request replayed', { key: fullKey });
      res.setHeader('X-Idempotent-Replayed', 'true');
      res.status(cached.statusCode).json(cached.body);
      return;
    }

    // Intercept res.json to cache the response
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      res.setHeader('X-Idempotent-Replayed', 'false');
      if (res.statusCode >= 200 && res.statusCode < 300 && store.size < CoreConstants.IDEMPOTENCY_MAX_STORE_SIZE) {
        store.set(fullKey, {
          statusCode: res.statusCode,
          body,
          expiresAt: Date.now() + CoreConstants.IDEMPOTENCY_TTL_MS,
        });
      }
      return originalJson(body);
    };

    next();
  };
}
