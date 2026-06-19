// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import {
  listRepositoriesUnderPrefix,
  listTags,
  getManifest,
  headBlob,
  isNotFound,
} from './registry-client.js';

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

  // Walk the registry catalog and collect every repo whose name starts with `prefix`.
  const reposBeingScanned = await listRepositoriesUnderPrefix(prefix);

  // Map each unique blob digest → a repo known to reference it. Docker
  // Distribution scopes blob access per-repo (`/v2/<repo>/blobs/<digest>`), so a
  // blob must be HEAD'd against a repo that actually has it; HEADing every digest
  // against a single repo 404s (and silently drops) blobs that live elsewhere,
  // systematically undercounting multi-repo orgs.
  const blobRepo = new Map<string, string>();
  for (const repo of reposBeingScanned) {
    try {
      const { tags } = await listTags(repo);
      for (const tag of tags) {
        try {
          const { body } = await getManifest(repo, tag);
          const digests = new Set<string>();
          collectBlobDigests(body, digests);
          for (const d of digests) if (!blobRepo.has(d)) blobRepo.set(d, repo);
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

  // Sum bytes via HEAD per unique blob, against a repo that references it. The
  // HEAD is cheap (no body transfer), but with hundreds of unique layers per org
  // this can take a few seconds; the cache amortizes that across subsequent calls.
  let totalBytes = 0;
  for (const [digest, repo] of blobRepo) {
    try {
      const head = await headBlob(repo, digest);
      if (typeof head.contentLength === 'number') totalBytes += head.contentLength;
    } catch (err) {
      if (!isNotFound(err)) {
        logger.warn('Blob HEAD failed during storage rollup', {
          digest, repo, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const now = Date.now();
  cache.set(prefix, {
    bytes: totalBytes,
    repos: reposBeingScanned.length,
    blobs: blobRepo.size,
    computedAt: now,
  });
  return {
    prefix,
    bytes: totalBytes,
    repos: reposBeingScanned.length,
    blobs: blobRepo.size,
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
