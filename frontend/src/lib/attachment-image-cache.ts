// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-wide cache of attachment image object-URLs, keyed by attachment id.
 *
 * Attachment bytes are auth-gated, so an image preview can't use a plain `src`
 * URL — it must fetch a blob and wrap it in an object URL. Without a shared
 * cache, every render/re-mount of the same attachment (thread re-render, the
 * same image in the inbox AND the open thread, scrolling a row out and back)
 * re-fetches the bytes and mints a new object URL. This module fetches ONCE per
 * id and hands every caller the same object URL.
 *
 * Lifecycle: the cache owns the object URL, so consumers must NOT revoke it on
 * unmount (that would break other live consumers + future mounts). Entries are
 * evicted LRU past {@link MAX_ENTRIES}, revoking the evicted URL. A failed fetch
 * is not cached, so a later mount retries.
 */

/** Max cached image URLs before LRU eviction (keeps blob memory bounded). */
const MAX_ENTRIES = 50;

/** id → in-flight-or-resolved object-URL promise. Insertion order = LRU order. */
const cache = new Map<string, Promise<string>>();

/**
 * Get (or start) the shared object-URL for a cached image. Coalesces concurrent
 * callers onto one fetch and reuses the result across mounts.
 *
 * @param cacheKey - unique key for this image variant (e.g. `<id>` or `<id>:thumb`)
 * @param fetchBlob - fetches the auth-gated bytes (the caller closes over the real id + options)
 */
export function getAttachmentImageUrl(cacheKey: string, fetchBlob: () => Promise<Blob>): Promise<string> {
  const id = cacheKey;
  const existing = cache.get(id);
  if (existing) {
    // LRU touch: re-insert so this key becomes the most-recently-used.
    cache.delete(id);
    cache.set(id, existing);
    return existing;
  }

  const promise = fetchBlob().then((blob) => URL.createObjectURL(blob));
  cache.set(id, promise);

  // Don't poison the cache on failure — drop so a later mount can retry.
  promise.catch(() => {
    if (cache.get(id) === promise) cache.delete(id);
  });

  // Evict the oldest entry when over the cap, revoking its URL to free memory.
  if (cache.size > MAX_ENTRIES) {
    const oldestId = cache.keys().next().value as string | undefined;
    if (oldestId !== undefined) {
      const evicted = cache.get(oldestId);
      cache.delete(oldestId);
      evicted?.then((url) => URL.revokeObjectURL(url)).catch(() => { /* never fetched → nothing to revoke */ });
    }
  }

  return promise;
}

/** Test/diagnostic helper: revoke all cached URLs and clear the map. */
export function clearAttachmentImageCache(): void {
  for (const p of cache.values()) p.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  cache.clear();
}
