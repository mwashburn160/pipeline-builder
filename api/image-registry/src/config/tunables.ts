// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_LEADER_LOCK_TTL_MS, envInt, envStr } from '@pipeline-builder/api-core';

/**
 * The image-registry service's operational tunables (timeouts, caches, rate
 * limits, concurrency, scheduler cadences), in one place. Exposed as
 * `config.tunables` by `./index.ts`.
 *
 * Kept in its own module, with no required variables, because `./index.ts`
 * THROWS without `IMAGE_REGISTRY_HOST` and the token-signing keys and is
 * replaced by partial mocks in many suites — the helpers that only need a
 * timeout or a cache TTL import this module directly so they stay loadable on
 * their own.
 *
 * Every value is read through api-core's `envInt` / `envStr` so the docs-drift
 * guard (`packages/api-core/test/env-documented.test.ts`) sees it. Plain values
 * resolve once at import time. The members declared as getters re-read the
 * environment on every access, as their original call sites did (the
 * schedulers read their settings when started; the GC protected-tag list and
 * the scan concurrency are read per use, and their tests vary them).
 */
export interface RegistryTunables {
  registryHttp: {
    /** Timeout (ms) on an ordinary registry API call. */
    timeoutMs: number;
    /** Socket-idle timeout (ms) on a streamed blob download. */
    blobStreamTimeoutMs: number;
  };
  /** Timeout (ms) on the platform `/auth/login` forward of a `docker login` (shared `HTTP_CLIENT_TIMEOUT_MS`). */
  platformLoginTimeoutMs: number;
  /** Largest blob (bytes) the images API proxies through. */
  maxBlobProxyBytes: number;
  /** Largest SBOM (bytes) accepted for an attestation. */
  sbomMaxBytes: number;
  copy: {
    /** Child manifests copied concurrently. */
    parallelChildren: number;
    /** Blobs (and tag/repository fan-outs) handled concurrently. */
    parallelBlobs: number;
  };
  tokenRateLimit: {
    windowMs: number;
    /** Token requests per principal per window. */
    max: number;
    /** Token requests per source IP per window. */
    ipMax: number;
    /** Cap on in-memory buckets when Redis is unavailable. */
    maxBuckets: number;
  };
  /** When true, an unverifiable storage cap lets a push through (default fail-closed). */
  storageFailOpen: boolean;
  storage: {
    /** TTL (ms) of one org's storage-usage reading. */
    cacheTtlMs: number;
    /** Oldest (ms) a cached per-repository breakdown may be served. */
    breakdownMaxStaleMs: number;
    /** Registry calls a storage scan keeps in flight. Read per scan. */
    readonly scanConcurrency: number;
  };
  /** TTL (ms) of the public-publication ownership cache. */
  publicationCacheTtlMs: number;
  /** TTL (ms) of a public-namespace publisher verification. */
  publicVerifyCacheTtlMs: number;
  /** Registry GC scheduler. Every member is read per access. */
  gc: {
    readonly enabled: boolean;
    readonly intervalHours: number;
    readonly maxAgeDays: number;
    readonly startupDelayMs: number;
    readonly lockTtlMs: number;
    /** Raw `REGISTRY_GC_PROTECTED_TAGS` ('' when unset). */
    readonly protectedTags: string;
  };
  /** Storage snapshot scheduler. Every member is read per access. */
  storageSnapshot: {
    readonly intervalMs: number;
    readonly startupDelayMs: number;
    readonly lockTtlMs: number;
  };
}

export const tunables: RegistryTunables = {
  registryHttp: {
    timeoutMs: envInt('REGISTRY_HTTP_TIMEOUT_MS', 30_000, { min: 1 }),
    blobStreamTimeoutMs: envInt('REGISTRY_BLOB_STREAM_TIMEOUT_MS', 30_000, { min: 1 }),
  },
  platformLoginTimeoutMs: envInt('HTTP_CLIENT_TIMEOUT_MS', 5000, { min: 1 }),
  maxBlobProxyBytes: envInt('REGISTRY_MAX_BLOB_PROXY_BYTES', 5 * 1024 * 1024, { min: 1 }),
  sbomMaxBytes: envInt('REGISTRY_SBOM_MAX_BYTES', 256 * 1024 * 1024, { min: 1024 }),
  copy: {
    parallelChildren: envInt('REGISTRY_COPY_PARALLEL_CHILDREN', 3, { min: 1 }),
    parallelBlobs: envInt('REGISTRY_COPY_PARALLEL_BLOBS', 8, { min: 1 }),
  },
  tokenRateLimit: {
    windowMs: envInt('REGISTRY_TOKEN_RATE_LIMIT_WINDOW_MS', 60_000, { min: 1 }),
    max: envInt('REGISTRY_TOKEN_RATE_LIMIT_MAX', 60, { min: 1 }),
    ipMax: envInt('REGISTRY_TOKEN_RATE_LIMIT_IP_MAX', 300, { min: 1 }),
    maxBuckets: envInt('REGISTRY_TOKEN_RATE_LIMIT_MAX_BUCKETS', 10_000, { min: 1 }),
  },
  // Exact (case-insensitive) `true` only, as before — this is a security escape hatch.
  storageFailOpen: envStr('QUOTA_STORAGE_FAIL_OPEN', '').toLowerCase() === 'true',
  storage: {
    cacheTtlMs: envInt('REGISTRY_STORAGE_CACHE_TTL_MS', 60_000, { min: 1 }),
    breakdownMaxStaleMs: envInt('REGISTRY_STORAGE_BREAKDOWN_MAX_STALE_MS', 600_000, { min: 1 }),
    get scanConcurrency() {
      return envInt('REGISTRY_STORAGE_SCAN_CONCURRENCY', 8, { min: 1, max: 64 });
    },
  },
  publicationCacheTtlMs: envInt('REGISTRY_PUBLICATION_CACHE_TTL_MS', 60_000, { min: 1 }),
  publicVerifyCacheTtlMs: envInt('PUBLIC_VERIFY_CACHE_TTL_MS', 60_000, { min: 1 }),
  gc: {
    get enabled() {
      return envStr('REGISTRY_GC_ENABLED', '') === 'true';
    },
    get intervalHours() {
      return envInt('REGISTRY_GC_INTERVAL_HOURS', 24, { min: 1 });
    },
    get maxAgeDays() {
      return envInt('REGISTRY_GC_MAX_AGE_DAYS', 30, { min: 1 });
    },
    get startupDelayMs() {
      return envInt('REGISTRY_GC_STARTUP_DELAY_MS', 300_000, { min: 0 });
    },
    get lockTtlMs() {
      return envInt('REGISTRY_GC_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1 });
    },
    get protectedTags() {
      return envStr('REGISTRY_GC_PROTECTED_TAGS', '');
    },
  },
  storageSnapshot: {
    get intervalMs() {
      return envInt('REGISTRY_STORAGE_SNAPSHOT_INTERVAL_MS', 600_000, { min: 60_000 });
    },
    get startupDelayMs() {
      return envInt('REGISTRY_STORAGE_SNAPSHOT_STARTUP_DELAY_MS', 30_000, { min: 0 });
    },
    get lockTtlMs() {
      return envInt('REGISTRY_STORAGE_SNAPSHOT_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1 });
    },
  },
};
