import { CacheService, createCacheService } from '../src/services/cache-service';

describe('CacheService (in-memory)', () => {
  let cache: CacheService;

  beforeEach(() => {
    cache = createCacheService('test:', 60);
  });

  afterEach(async () => {
    await cache.clear();
  });

  describe('get/set', () => {
    it('returns null on cache miss', async () => {
      expect(await cache.get('missing')).toBeNull();
    });

    it('stores and retrieves a value', async () => {
      await cache.set('key1', { name: 'test' });
      expect(await cache.get('key1')).toEqual({ name: 'test' });
    });

    it('stores string values', async () => {
      await cache.set('str', 'hello');
      expect(await cache.get('str')).toBe('hello');
    });

    it('stores number values', async () => {
      await cache.set('num', 42);
      expect(await cache.get('num')).toBe(42);
    });

    it('stores array values', async () => {
      await cache.set('arr', [1, 2, 3]);
      expect(await cache.get('arr')).toEqual([1, 2, 3]);
    });

    it('returns null for expired entries', async () => {
      await cache.set('expiring', 'value', 0); // 0 second TTL
      // Wait a tick for expiry
      await new Promise((r) => setTimeout(r, 10));
      expect(await cache.get('expiring')).toBeNull();
    });

    it('respects custom TTL', async () => {
      await cache.set('long', 'value', 3600);
      expect(await cache.get('long')).toBe('value');
    });
  });

  describe('del', () => {
    it('removes a cached value', async () => {
      await cache.set('key1', 'value');
      await cache.del('key1');
      expect(await cache.get('key1')).toBeNull();
    });

    it('does nothing for missing key', async () => {
      await cache.del('nonexistent'); // Should not throw
    });
  });

  describe('invalidatePattern', () => {
    it('removes matching keys', async () => {
      await cache.set('org1:list', [1]);
      await cache.set('org1:detail:a', { a: 1 });
      await cache.set('org2:list', [2]);

      const deleted = await cache.invalidatePattern('org1:*');
      expect(deleted).toBe(2);
      expect(await cache.get('org1:list')).toBeNull();
      expect(await cache.get('org1:detail:a')).toBeNull();
      expect(await cache.get('org2:list')).toEqual([2]); // Unaffected
    });

    it('returns 0 when no keys match', async () => {
      const deleted = await cache.invalidatePattern('nonexistent:*');
      expect(deleted).toBe(0);
    });
  });

  describe('getOrSet', () => {
    it('returns cached value on hit', async () => {
      await cache.set('key1', 'cached');
      const factory = jest.fn().mockResolvedValue('computed');

      const result = await cache.getOrSet('key1', factory);
      expect(result).toBe('cached');
      expect(factory).not.toHaveBeenCalled();
    });

    it('calls factory and caches on miss', async () => {
      const factory = jest.fn().mockResolvedValue('computed');

      const result = await cache.getOrSet('key1', factory);
      expect(result).toBe('computed');
      expect(factory).toHaveBeenCalledTimes(1);

      // Second call should use cache
      const result2 = await cache.getOrSet('key1', factory);
      expect(result2).toBe('computed');
      expect(factory).toHaveBeenCalledTimes(1); // Not called again
    });
  });

  describe('clear', () => {
    it('removes all entries', async () => {
      await cache.set('a', 1);
      await cache.set('b', 2);
      await cache.clear();
      expect(cache.size).toBe(0);
    });
  });

  describe('size', () => {
    it('tracks entry count', async () => {
      expect(cache.size).toBe(0);
      await cache.set('a', 1);
      expect(cache.size).toBe(1);
      await cache.set('b', 2);
      expect(cache.size).toBe(2);
    });
  });

  describe('max entries', () => {
    it('evicts oldest entry when at capacity', async () => {
      const smallCache = new CacheService({ prefix: 'small:', defaultTtlSeconds: 60, maxEntries: 2 });

      await smallCache.set('first', 1);
      await smallCache.set('second', 2);
      await smallCache.set('third', 3); // Should evict 'first'

      expect(await smallCache.get('first')).toBeNull();
      expect(await smallCache.get('second')).toBe(2);
      expect(await smallCache.get('third')).toBe(3);
    });
  });
});

describe('createCacheService', () => {
  it('creates a CacheService with defaults', () => {
    const cache = createCacheService('test:');
    expect(cache).toBeInstanceOf(CacheService);
    expect(cache.size).toBe(0);
  });

  it('creates with custom TTL', () => {
    const cache = createCacheService('test:', 120);
    expect(cache).toBeInstanceOf(CacheService);
  });
});
