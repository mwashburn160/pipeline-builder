import { createLogger } from '@mwashburn160/api-core';
import { CoreConstants } from '@mwashburn160/pipeline-core';
import { Request, Response, NextFunction } from 'express';

const logger = createLogger('CacheService');

/**
 * Simple in-memory cache with TTL support.
 * Optionally backed by Redis when a Redis client is provided.
 */
export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Cache service configuration
 */
export interface CacheServiceOptions {
  /** Redis client for distributed caching. Uses in-memory Map when omitted. */
  client?: CacheClient;
  /** Default TTL in seconds (default: 60) */
  defaultTtlSeconds?: number;
  /** Key prefix to namespace cache entries */
  keyPrefix?: string;
}

/**
 * Lightweight cache service supporting both in-memory and Redis backends.
 * Used for caching read-heavy API responses.
 */
export class CacheService {
  private readonly client: CacheClient | null;
  private readonly defaultTtl: number;
  private readonly keyPrefix: string;
  private readonly memoryCache: Map<string, { value: string; expiresAt: number }>;

  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options: CacheServiceOptions = {}) {
    this.client = options.client ?? null;
    this.defaultTtl = options.defaultTtlSeconds ?? 60;
    this.keyPrefix = options.keyPrefix ?? 'cache:';
    this.memoryCache = new Map();

    // Periodic cleanup of expired in-memory entries
    if (!this.client) {
      this.cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of this.memoryCache) {
          if (now > entry.expiresAt) this.memoryCache.delete(key);
        }
      }, CoreConstants.CACHE_CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref();
    }
  }

  private fullKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const fk = this.fullKey(key);

    if (this.client) {
      try {
        const raw = await this.client.get(fk);
        return raw ? JSON.parse(raw) as T : null;
      } catch (err) {
        logger.debug('Cache get error', { key: fk, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }

    // In-memory fallback
    const entry = this.memoryCache.get(fk);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.memoryCache.delete(fk);
      return null;
    }
    return JSON.parse(entry.value) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const fk = this.fullKey(key);
    const ttl = ttlSeconds ?? this.defaultTtl;
    const serialized = JSON.stringify(value);

    if (this.client) {
      try {
        await this.client.set(fk, serialized, 'EX', ttl);
      } catch (err) {
        logger.debug('Cache set error', { key: fk, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // In-memory fallback
    this.memoryCache.set(fk, {
      value: serialized,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  async invalidate(key: string): Promise<void> {
    const fk = this.fullKey(key);
    if (this.client) {
      try {
        await this.client.del(fk);
      } catch {
        // Swallow — best-effort invalidation
      }
    }
    this.memoryCache.delete(fk);
  }

  /**
   * Express middleware that caches GET responses.
   *
   * Cache key = orgId + URL path + query string.
   * Skips caching for non-200 responses and requests with no-cache header.
   *
   * @param ttlSeconds - Time-to-live for cached responses
   */
  middleware(ttlSeconds?: number) {
    const cache = this;
    const ttl = ttlSeconds ?? this.defaultTtl;

    return async (req: Request, res: Response, next: NextFunction) => {
      // Only cache GET requests
      if (req.method !== 'GET') return next();

      // Respect no-cache
      if (req.headers['cache-control']?.includes('no-cache')) return next();

      const orgId = (req as any).orgId || (req as any).identity?.orgId || 'anon';
      const cacheKey = `${orgId}:${req.originalUrl}`;

      const cached = await cache.get<{ body: unknown; statusCode: number }>(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        res.status(cached.statusCode).json(cached.body);
        return;
      }

      // Intercept res.json to cache the response
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cache.set(cacheKey, { body, statusCode: res.statusCode }, ttl).catch(() => {});
        }
        res.setHeader('X-Cache', 'MISS');
        return originalJson(body);
      };

      next();
    };
  }
}
