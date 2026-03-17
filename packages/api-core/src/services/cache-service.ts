/**
 * Lightweight caching service with TTL support.
 *
 * Two implementations:
 * - In-memory (default): LRU-style Map cache, no external dependencies
 * - Redis: When a Redis client is provided, uses Redis for cross-process caching
 *
 * Design:
 * - All operations are fail-safe: cache misses/errors return null, never throw
 * - JSON serialization for Redis; direct reference for in-memory
 * - Key namespace prefixing to avoid collisions between services
 */


/**
 * Cache entry with value and expiration time.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number; // Unix timestamp in ms
}

/**
 * Minimal Redis-like client interface (subset of ioredis).
 * Services pass their own Redis client instance.
 */
export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

export interface CacheConfig {
  /** Key prefix for namespace isolation (e.g., 'plugin:', 'compliance:') */
  prefix: string;
  /** Default TTL in seconds */
  defaultTtlSeconds: number;
  /** Max entries for in-memory cache (default 1000) */
  maxEntries?: number;
  /** Optional Redis client — uses in-memory cache if not provided */
  redis?: RedisCacheClient;
}

/**
 * Cache service with get/set/del operations and automatic TTL expiry.
 *
 * @example
 * ```typescript
 * const cache = new CacheService({ prefix: 'plugin:', defaultTtlSeconds: 300 });
 *
 * // Set with default TTL
 * await cache.set('org123:list', plugins);
 *
 * // Get (returns null on miss)
 * const cached = await cache.get<Plugin[]>('org123:list');
 *
 * // Invalidate
 * await cache.del('org123:list');
 *
 * // Invalidate by pattern
 * await cache.invalidatePattern('org123:*');
 * ```
 */
export class CacheService {
  private memory = new Map<string, CacheEntry<unknown>>();
  private readonly prefix: string;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly redis?: RedisCacheClient;

  constructor(config: CacheConfig) {
    this.prefix = config.prefix;
    this.defaultTtlMs = config.defaultTtlSeconds * 1000;
    this.maxEntries = config.maxEntries ?? 1000;
    this.redis = config.redis;
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * Get a cached value. Returns null on miss or error.
   */
  async get<T>(key: string): Promise<T | null> {
    const fk = this.fullKey(key);

    try {
      if (this.redis) {
        const raw = await this.redis.get(fk);
        if (!raw) return null;
        return JSON.parse(raw) as T;
      }

      // In-memory
      const entry = this.memory.get(fk);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        this.memory.delete(fk);
        return null;
      }
      return entry.value as T;
    } catch {
      return null;
    }
  }

  /**
   * Set a cached value with optional TTL override.
   *
   * @param key - Cache key (prefix is added automatically)
   * @param value - Value to cache (must be JSON-serializable for Redis)
   * @param ttlSeconds - TTL override (uses default if not provided)
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const fk = this.fullKey(key);
    const ttl = ttlSeconds ?? this.defaultTtlMs / 1000;

    try {
      if (this.redis) {
        await this.redis.set(fk, JSON.stringify(value), 'EX', ttl);
        return;
      }

      // In-memory — evict oldest if at capacity
      if (this.memory.size >= this.maxEntries) {
        const firstKey = this.memory.keys().next().value;
        if (firstKey) this.memory.delete(firstKey);
      }

      this.memory.set(fk, {
        value,
        expiresAt: Date.now() + ttl * 1000,
      });
    } catch {
      // Cache set failure is non-fatal
    }
  }

  /**
   * Delete a cached value.
   */
  async del(key: string): Promise<void> {
    const fk = this.fullKey(key);

    try {
      if (this.redis) {
        await this.redis.del(fk);
        return;
      }
      this.memory.delete(fk);
    } catch {
      // Cache delete failure is non-fatal
    }
  }

  /**
   * Invalidate all keys matching a pattern (e.g., 'org123:*').
   * For in-memory cache, iterates all keys. For Redis, uses KEYS command.
   *
   * Note: Redis KEYS is O(N) — use sparingly in production. Consider SCAN for large datasets.
   */
  async invalidatePattern(pattern: string): Promise<number> {
    const fp = this.fullKey(pattern);

    try {
      if (this.redis) {
        const keys = await this.redis.keys(fp);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
        return keys.length;
      }

      // In-memory — match glob-style pattern
      const regex = new RegExp('^' + fp.replace(/\*/g, '.*') + '$');
      let deleted = 0;
      for (const key of this.memory.keys()) {
        if (regex.test(key)) {
          this.memory.delete(key);
          deleted++;
        }
      }
      return deleted;
    } catch {
      return 0;
    }
  }

  /**
   * Get or compute: returns cached value if available, otherwise calls the
   * factory function, caches the result, and returns it.
   *
   * @param key - Cache key
   * @param factory - Async function to compute the value on cache miss
   * @param ttlSeconds - Optional TTL override
   * @returns The cached or computed value
   */
  async getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  /**
   * Clear all entries (useful for testing).
   */
  async clear(): Promise<void> {
    if (this.redis) {
      await this.invalidatePattern('*');
    } else {
      this.memory.clear();
    }
  }

  /** Current in-memory cache size (for diagnostics). */
  get size(): number {
    return this.memory.size;
  }
}

/**
 * Create a cache service instance.
 *
 * @param prefix - Namespace prefix (e.g., 'compliance:', 'plugin:')
 * @param defaultTtlSeconds - Default TTL in seconds (default 300 = 5 min)
 * @param redis - Optional Redis client for cross-process caching
 */
export function createCacheService(
  prefix: string,
  defaultTtlSeconds = 300,
  redis?: RedisCacheClient,
): CacheService {
  return new CacheService({ prefix, defaultTtlSeconds, redis });
}
