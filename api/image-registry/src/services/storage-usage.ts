// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import {
  listRepositories,
  listTags,
  getManifest,
  headBlob,
  isNotFound,
} from './registry-client';

const logger = createLogger('storage-usage');

/**
 * In-memory cache for per-org storage totals. Computing a usage rollup
 * requires N HEAD calls per layer × M tags × R repos — too expensive to
 * run on every request. The cache is keyed by the repo namespace prefix
 * (e.g. `org-acme/`) and refreshed after `CACHE_TTL_MS`.
 *
 * 60s is a deliberate trade-off: short enough that an admin running a
 * cleanup sees the freed-up bytes promptly, long enough that a noisy
 * dashboard auto-refresh doesn't hammer the registry.
 */
/** Override via `REGISTRY_STORAGE_CACHE_TTL_MS`. */
const CACHE_TTL_MS = parseInt(process.env.REGISTRY_STORAGE_CACHE_TTL_MS || '60000', 10);
const cache = new Map<string, { bytes: number; repos: number; blobs: number; computedAt: number }>();

export interface StorageUsage {
  /** Repo namespace prefix used to compute the rollup (e.g. `org-acme/`). */
  prefix: string;
  /** Total unique blob bytes across all repos with this prefix. */
  bytes: number;
  /** Count of repos scanned for the rollup. */
  repos: number;
  /** Count of unique blob digests across those repos. */
  blobs: number;
  /** Epoch ms when this rollup was computed; helps callers reason about staleness. */
  computedAt: number;
}

/**
 * Sum unique blob bytes across every repo with the given prefix. Each
 * blob digest is counted once even if it appears in multiple tags or
 * across multiple child manifests (multi-arch index) — the underlying
 * registry deduplicates by digest, so the bytes-on-disk match this.
 *
 * Cached per-prefix; pass `force: true` to bypass and recompute.
 *
 * @example
 * ```typescript
 * const usage = await computeStorageUsage('org-acme/');
 * console.log(usage.bytes, usage.blobs);
 * ```
 */
export async function computeStorageUsage(
  prefix: string,
  opts: { force?: boolean } = {},
): Promise<StorageUsage> {
  const cached = cache.get(prefix);
  if (!opts.force && cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return {
      prefix,
      bytes: cached.bytes,
      repos: cached.repos,
      blobs: cached.blobs,
      computedAt: cached.computedAt,
    };
  }

  const reposBeingScanned: string[] = [];
  let cursor: string | undefined;
  // Walk the registry catalog and collect every repo whose name starts
  // with `prefix`. Pagination cap on registry is 100 names per page.
  do {
    const page = await listRepositories({ n: 100, last: cursor });
    for (const r of page.repositories) {
      if (r.startsWith(prefix)) reposBeingScanned.push(r);
    }
    cursor = page.next;
  } while (cursor);

  const uniqueBlobs = new Set<string>();
  for (const repo of reposBeingScanned) {
    try {
      const { tags } = await listTags(repo);
      for (const tag of tags) {
        try {
          const { body } = await getManifest(repo, tag);
          collectBlobDigests(body, uniqueBlobs);
        } catch (err) {
          if (!isNotFound(err)) {
            logger.warn('Manifest fetch failed during storage rollup', {
              repo, tag, error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch (err) {
      logger.warn('Tag list failed during storage rollup', {
        repo, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Sum bytes via HEAD per unique blob. The blob HEAD is cheap (no body
  // transfer), but with hundreds of unique layers per org this can take a
  // few seconds. The cache amortizes that cost across subsequent calls.
  let totalBytes = 0;
  for (const digest of uniqueBlobs) {
    try {
      // We don't know which repo a blob "belongs to" — pass any repo from
      // the scanned set, the registry resolves by digest globally.
      const repo = reposBeingScanned[0];
      if (!repo) break;
      const head = await headBlob(repo, digest);
      if (typeof head.contentLength === 'number') totalBytes += head.contentLength;
    } catch (err) {
      if (!isNotFound(err)) {
        logger.warn('Blob HEAD failed during storage rollup', {
          digest, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const now = Date.now();
  cache.set(prefix, {
    bytes: totalBytes,
    repos: reposBeingScanned.length,
    blobs: uniqueBlobs.size,
    computedAt: now,
  });
  return {
    prefix,
    bytes: totalBytes,
    repos: reposBeingScanned.length,
    blobs: uniqueBlobs.size,
    computedAt: now,
  };
}

/** Force-evict a cached rollup so the next call recomputes. Used by the
 *  GC endpoint after pruning so the dashboard shows the freed bytes. */
export function invalidateStorageCache(prefix: string): void {
  cache.delete(prefix);
}

/**
 * Walk a manifest body and add every referenced blob digest to `out`.
 * Handles both single-arch (image manifest) and multi-arch (index) layouts.
 * Index children's blobs are NOT recursed into — the registry's blob
 * store is global, so a layer referenced by a child manifest is counted
 * regardless of which child references it.
 */
function collectBlobDigests(body: unknown, out: Set<string>): void {
  if (typeof body !== 'object' || body === null) return;
  const b = body as Record<string, unknown>;

  // Single-arch image manifest: { config: {digest}, layers: [{digest}, ...] }
  const configDigest = (b.config as { digest?: string } | undefined)?.digest;
  if (configDigest) out.add(configDigest);
  const layers = b.layers as Array<{ digest: string }> | undefined;
  if (Array.isArray(layers)) {
    for (const l of layers) if (l.digest) out.add(l.digest);
  }

  // Multi-arch index: { manifests: [{digest}, ...] }
  // Child manifests are themselves blobs (digest-addressable) so include
  // them in the count — the bytes-on-disk include the manifest JSON.
  const indexChildren = b.manifests as Array<{ digest: string }> | undefined;
  if (Array.isArray(indexChildren)) {
    for (const c of indexChildren) if (c.digest) out.add(c.digest);
  }
}
