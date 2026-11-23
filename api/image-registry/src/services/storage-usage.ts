// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { envInt, createLogger, errorMessage } from '@pipeline-builder/api-core';
import { setGauge } from '@pipeline-builder/api-server';
import { mapWithConcurrency, type Limiter } from './concurrency.js';
import { inPublicNamespace, inQuarantineNamespace, PUBLIC_PREFIX } from './namespaces.js';
import { publicRepositoriesOwnedBy } from './public-publications.js';
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
const CACHE_TTL_MS = envInt('REGISTRY_STORAGE_CACHE_TTL_MS', 60_000, { min: 1 });
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
  /**
   * True when the scan hit a non-404 error (a repo's tags, a manifest, or a
   * blob HEAD failed) and the byte total may therefore UNDER-count real usage.
   * A fail-closed caller (the push-gate) must treat an incomplete rollup as
   * inconclusive rather than "under budget". Incomplete rollups are not cached.
   */
  incomplete: boolean;
}

/** One measured blob: its size, and every `repo:tag` that references it. */
interface BlobFacts {
  size: number;
  refs: string[];
}

/** `repo:tag`, the breakdown's reference key. Tags cannot contain `:`. */
const tagRef = (repo: string, tag: string): string => `${repo}:${tag}`;

/** What one image version costs, and what removing it would actually free. */
export interface StorageBreakdownEntry {
  repo: string;
  tag: string;
  /**
   * Every byte this version's layers occupy, shared ones included. Useful for
   * "what is big", useless for "what should I delete" — these sum to far more
   * than the org's total, because a shared base layer is counted in every
   * version that references it.
   */
  totalBytes: number;
  /**
   * Bytes that would actually come back if THIS version alone were removed:
   * the blobs nothing else in the organization references.
   *
   * This is the only honest number to show beside a delete button. Under
   * deduplication, deleting one of ten versions sharing a 400 MB base frees
   * only that version's own layers — possibly a few MB where `totalBytes`
   * would promise 500. A surface showing the naive figure promises space it
   * cannot free, which is a worse failure than showing nothing.
   */
  marginalBytes: number;
  /**
   * A published (`public/*`) copy, whose bytes stay billed to the publisher
   * after the private version is deleted. Not prunable here — freeing them
   * means unlisting or withdrawing the publication.
   */
  published: boolean;
}

/** Per-version attribution for an org's storage, and what each prune frees. */
export interface StorageBreakdown {
  orgId: string;
  /** The org's total, over the same scope as the storage snapshot (`storage-snapshot.ts`). */
  bytes: number;
  /** Highest `marginalBytes` first: the versions worth deleting, in order. */
  entries: StorageBreakdownEntry[];
  computedAt: number;
  /**
   * True when the scan could not measure everything. The entries then
   * UNDER-state both figures, so a surface must say the breakdown is partial
   * rather than present it as the whole picture.
   */
  incomplete: boolean;
}

const breakdownCache = new Map<string, StorageBreakdown>();

/**
 * How long a complete breakdown may still be SERVED (while a refresh runs in
 * the background) once it is older than `CACHE_TTL_MS`. A breakdown costs a
 * full catalog walk plus a scan — tens of seconds on an object-store backend,
 * past the route's deadline — so recomputing on every view past the 60s TTL
 * meant the Storage page never loaded. Override via
 * `REGISTRY_STORAGE_BREAKDOWN_MAX_STALE_MS`.
 */
const BREAKDOWN_MAX_STALE_MS = envInt('REGISTRY_STORAGE_BREAKDOWN_MAX_STALE_MS', 600_000, { min: 1 });

/** The one in-flight computation per org: concurrent views share it. */
const breakdownInflight = new Map<string, Promise<StorageBreakdown>>();

/**
 * Bumped by {@link invalidateOrgStorageCache}. A computation only caches its
 * result if no invalidation happened while it ran — otherwise a scan that
 * started before a prune would put the deleted versions back.
 */
const breakdownGeneration = new Map<string, number>();

/**
 * Per-version storage attribution for an org: what each image version costs,
 * and what deleting it would actually free.
 *
 * Scope matches the storage snapshot (`storage-snapshot.ts`) exactly — the org's own
 * namespace plus the `public/*` repositories it has published — so the
 * breakdown's total equals the figure the push gate enforces and the dashboard
 * shows. A breakdown that disagreed with the cap would be worse than none.
 *
 * EXPENSIVE: the same catalog walk and per-blob HEADs as the rollup, so it is
 * cached on its own key and must never be called from the token-issuance path.
 * The rollup stays the cheap read; this is the on-demand "what is using my
 * storage" answer.
 */
export async function computeOrgStorageBreakdown(
  orgId: string,
  opts: { force?: boolean } = {},
): Promise<StorageBreakdown> {
  const key = `${ORG_BREAKDOWN_KEY}${orgId}`;
  const cached = breakdownCache.get(key);
  if (!opts.force && cached) {
    const age = Date.now() - cached.computedAt;
    if (age < CACHE_TTL_MS) return cached;
    // Stale but recent enough: answer now, refresh behind it. `computedAt`
    // tells the caller how old the figures are.
    if (age < Math.max(BREAKDOWN_MAX_STALE_MS, CACHE_TTL_MS)) {
      refreshOrgStorageBreakdown(orgId).catch((err: unknown) => {
        logger.warn('Background storage breakdown refresh failed', { orgId, error: errorMessage(err) });
      });
      return cached;
    }
  }
  return refreshOrgStorageBreakdown(orgId);
}

/**
 * Compute an org's breakdown, sharing an in-flight computation if there is
 * one (several page loads in a row used to start several catalog walks at
 * once, which slowed the object store until they timed out), and cache it
 * when complete and not invalidated meanwhile.
 */
function refreshOrgStorageBreakdown(orgId: string): Promise<StorageBreakdown> {
  const key = `${ORG_BREAKDOWN_KEY}${orgId}`;
  const running = breakdownInflight.get(key);
  if (running) return running;
  const generation = breakdownGeneration.get(key) ?? 0;
  const run: Promise<StorageBreakdown> = measureOrgStorageBreakdown(orgId)
    .then((result) => {
      // Never cache a partial answer, for the same reason the rollup does not:
      // a cached under-count outlives the outage that caused it.
      if (!result.incomplete && (breakdownGeneration.get(key) ?? 0) === generation) breakdownCache.set(key, result);
      return result;
    })
    .finally(() => {
      if (breakdownInflight.get(key) === run) breakdownInflight.delete(key);
    });
  breakdownInflight.set(key, run);
  return run;
}

/** One uncached breakdown measurement (see {@link computeOrgStorageBreakdown}). */
async function measureOrgStorageBreakdown(orgId: string): Promise<StorageBreakdown> {
  const { repos, recordsComplete } = await orgScanRepositories(orgId);
  const scan = await scanRepositories(repos, { detail: true });
  const incomplete = scan.incomplete || !recordsComplete;

  // Attribute each measured blob to the tags that reference it. A blob with
  // exactly one referencing tag is that version's own; anything shared is
  // counted in `totalBytes` for every referencing tag and in NO tag's
  // `marginalBytes`.
  const byRef = new Map<string, { total: number; marginal: number }>();
  const bump = (ref: string, total: number, marginal: number): void => {
    const e = byRef.get(ref) ?? { total: 0, marginal: 0 };
    e.total += total;
    e.marginal += marginal;
    byRef.set(ref, e);
  };
  for (const facts of (scan.perBlob ?? new Map<string, BlobFacts>()).values()) {
    const sole = facts.refs.length === 1;
    for (const ref of facts.refs) bump(ref, facts.size, sole ? facts.size : 0);
  }

  const entries: StorageBreakdownEntry[] = [...byRef.entries()]
    .map(([ref, e]) => {
      const idx = ref.lastIndexOf(':');
      const repo = ref.slice(0, idx);
      return {
        repo,
        tag: ref.slice(idx + 1),
        totalBytes: e.total,
        marginalBytes: e.marginal,
        published: inPublicNamespace(repo),
      };
    })
    // Biggest reclaimable first — the order a prune surface should offer.
    .sort((a, b) => b.marginalBytes - a.marginalBytes || b.totalBytes - a.totalBytes);

  return {
    orgId,
    bytes: scan.bytes,
    entries,
    computedAt: Date.now(),
    incomplete,
  };
}

/** What retiring one SYSTEM plugin version (every copy of it) would free. */
export interface RetentionBreakdownEntry {
  /** The plugin name (`system/<name>`, `public/<handle>/<name>`). */
  name: string;
  /** The version — its registry tag in every copy. */
  version: string;
  /** Every byte the version's layers occupy across its copies, shared ones included. */
  totalBytes: number;
  /**
   * Bytes that come back once EVERY copy of the version is gone (its
   * `system/<name>` build copy and its `public/*` copy): the blobs no other
   * version, no other plugin and no base image references. A lower bound when
   * several versions of one plugin retire together (a layer only they share
   * counts for none of them).
   */
  marginalBytes: number;
}

/** The system org's per-version retention attribution. */
export interface RetentionBreakdown {
  entries: RetentionBreakdownEntry[];
  computedAt: number;
  /** True when the scan could not measure everything: every figure UNDER-states. */
  incomplete: boolean;
}

/** `<name>@<version>` of a system or public plugin tag reference, or null for anything else (a base image, `library/*`). */
function pluginVersionUnit(ref: string): string | null {
  const at = ref.lastIndexOf(':');
  const repo = ref.slice(0, at);
  const tag = ref.slice(at + 1);
  const m = /^(?:system|public\/[^/]+)\/([^/]+)$/.exec(repo);
  if (!m || m[1]!.endsWith('-base')) return null;
  return `${m[1]}@${tag}`;
}

/**
 * Per-version attribution for the SYSTEM org's plugin catalogue, for the
 * superseded-version retention pass: one entry per plugin version, its
 * `system/<name>` and `public/*` copies counted as ONE unit, and every other
 * repository under `system/` and `library/` (the base images) scanned as a
 * sharer — so a base layer is never counted as freeable. Not cached: an
 * operator's dry run, not a hot path.
 */
export async function computeSystemRetentionBreakdown(systemOrgId: string): Promise<RetentionBreakdown> {
  let recordsComplete = true;
  let published: string[] = [];
  try {
    const owned = await publicRepositoriesOwnedBy(systemOrgId);
    published = owned.repositories;
    recordsComplete = owned.complete;
  } catch (err) {
    recordsComplete = false;
    logger.warn('Publication records unreadable during the retention breakdown', { error: errorMessage(err) });
  }
  const repos = [...await listRepositoriesUnderPrefix('system/'), ...await listRepositoriesUnderPrefix('library/'), ...published];
  const scan = await scanRepositories(repos, { detail: true });

  const byUnit = new Map<string, { total: number; marginal: number }>();
  for (const facts of (scan.perBlob ?? new Map<string, BlobFacts>()).values()) {
    const units = facts.refs.map(pluginVersionUnit);
    const distinct = new Set(units);
    const sole = !distinct.has(null) && distinct.size === 1;
    for (const unit of distinct) {
      if (unit === null) continue;
      const e = byUnit.get(unit) ?? { total: 0, marginal: 0 };
      e.total += facts.size;
      if (sole) e.marginal += facts.size;
      byUnit.set(unit, e);
    }
  }
  const entries = [...byUnit.entries()].map(([unit, e]) => {
    const at = unit.lastIndexOf('@');
    return { name: unit.slice(0, at), version: unit.slice(at + 1), totalBytes: e.total, marginalBytes: e.marginal };
  }).sort((a, b) => b.marginalBytes - a.marginalBytes || a.name.localeCompare(b.name));
  return { entries, computedAt: Date.now(), incomplete: scan.incomplete || !recordsComplete };
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
      incomplete: false, // only complete rollups are cached
    };
  }

  // Walk the registry catalog and collect every repo whose name starts with `prefix`.
  // `quarantine/*` (anonymous submissions awaiting moderation) belongs to no
  // tenant: it is counted ONLY when the quarantine namespace itself is asked for
  // (the quarantine GC sweep's gauge), never inside a shorter prefix a tenant or
  // admin rollup could pass (`q`, `` …).
  const reposBeingScanned = (await listRepositoriesUnderPrefix(prefix))
    .filter((r) => inQuarantineNamespace(prefix) || !inQuarantineNamespace(r));
  const { bytes: totalBytes, blobs, incomplete } = await scanRepositories(reposBeingScanned);

  const now = Date.now();
  // Only cache a COMPLETE rollup — caching a partial (under-counted) total would
  // serve a wrong "under budget" reading for the whole TTL.
  if (!incomplete) {
    cache.set(prefix, {
      bytes: totalBytes,
      repos: reposBeingScanned.length,
      blobs,
      computedAt: now,
    });
  }
  // The whole public namespace's footprint — refreshed
  // whenever it is rolled up (the GC scheduler's sweep, or the admin route).
  if (prefix === PUBLIC_PREFIX && !incomplete) setGauge(PUBLIC_STORAGE_GAUGE, {}, totalBytes);
  return {
    prefix,
    bytes: totalBytes,
    repos: reposBeingScanned.length,
    blobs,
    computedAt: now,
    incomplete,
  };
}

/** Gauge: unique blob bytes under `public/*`. */
export const PUBLIC_STORAGE_GAUGE = 'registry_public_storage_bytes';

/**
 * An ORG's `storageBytes` rollup: its own `org-<id>/*` namespace PLUS every
 * `public/<handle>/<name>` repository billed to it (the
 * publisher pays for what it published, even after deleting its private copy).
 * Blobs are deduplicated across the whole set: a public copy MOUNTS the org's
 * blobs, so a layer shared by both is one set of bytes on disk and counted once.
 *
 * `incomplete` is also set when a publication record couldn't be read — the
 * fail-closed push gate must not under-count an org because of it.
 */
/**
 * The exact repository set an org's storage is measured over: its own
 * `org-<id>/*` namespace plus every `public/*` repository billed to it.
 *
 * Shared by the rollup and the breakdown so the two can never disagree about
 * SCOPE. They did not before only because there was one caller; a breakdown
 * measuring a different set than the push gate enforces would show an
 * organization a figure that does not add up to the cap refusing its pushes.
 *
 * `recordsComplete` is false when the publication records could not be read —
 * the fail-closed gate must not under-count an org because of it.
 */
async function orgScanRepositories(orgId: string): Promise<{ repos: string[]; recordsComplete: boolean }> {
  // ONE catalog walk, reused for the org's own namespace AND the publication
  // records (the storage snapshot does the same). On an object-store backend
  // the walk is the expensive part: measured 2026-11-23 at ~24-29s for 374
  // repositories, and walking it twice (once inside the publication-owner read,
  // once for `org-<id>/`) put the system org's breakdown at ~65s.
  const catalog = await listRepositoriesUnderPrefix('');
  let recordsComplete = true;
  let published: string[] = [];
  try {
    const owned = await publicRepositoriesOwnedBy(orgId, { catalog });
    published = owned.repositories;
    recordsComplete = owned.complete;
  } catch (err) {
    recordsComplete = false;
    logger.warn('Publication records unreadable during org storage rollup', { orgId, error: errorMessage(err) });
  }
  // `org-<id>/` can never match `quarantine/*`, and publication records only
  // name `public/*` repos — anonymous-submission bytes are never billed to a tenant.
  const own = `org-${orgId}/`;
  return { repos: [...catalog.filter((r) => r.startsWith(own)), ...published], recordsComplete };
}

/** Cache-key namespace for org breakdowns (never a valid repo prefix). */
const ORG_BREAKDOWN_KEY = 'org-breakdown:';

/**
 * Registry calls a scan keeps in flight at once, per phase
 * (`REGISTRY_STORAGE_SCAN_CONCURRENCY`, default 8, clamped 1–64). One call at a
 * time made a whole-registry walk take as long as the sum of every call's
 * latency; unbounded would flood the registry. Read per scan so a test (or a
 * restart with a new value) picks it up.
 */
export function storageScanConcurrency(): number {
  return envInt('REGISTRY_STORAGE_SCAN_CONCURRENCY', 8, { min: 1, max: 64 });
}

/**
 * Time a scan spent in each kind of registry call, in ms: the sum of every
 * call's own duration, accumulated across calls so one accumulator can total a
 * whole multi-org snapshot run. With concurrent calls (see
 * {@link storageScanConcurrency}) this is call time, not wall time — it can
 * exceed the run's elapsed time, and its proportions still say which kind of
 * call the registry is slow at.
 */
export interface ScanTimings {
  tagsMs: number;
  manifestsMs: number;
  blobHeadsMs: number;
}

/** One repository's share of a scan: the unique blobs billed to it (see
 *  {@link scanRepositories} `perRepo`), and whether any of them, or its tags or
 *  manifests, could not be measured. */
export interface RepoUsage {
  bytes: number;
  blobs: number;
  incomplete: boolean;
}

/** A zeroed {@link ScanTimings} accumulator. */
export function newScanTimings(): ScanTimings {
  return { tagsMs: 0, manifestsMs: 0, blobHeadsMs: 0 };
}

/**
 * Sum unique blob bytes across `repos`. The shared core of every rollup;
 * `incomplete` when anything couldn't be measured (see {@link StorageUsage}).
 * Pass `timings` to accumulate where the time went (the storage snapshot does),
 * and `perRepo` for each repository's share (each unique blob billed once, to
 * the first repository in input order that references it).
 *
 * Three phases — tag lists, then manifests, then blob HEADs — each with at
 * most {@link storageScanConcurrency} calls in flight. `limiter`, when given,
 * additionally caps every registry call against a budget shared with other
 * scans (the snapshot scans several orgs at once). Results are assembled in
 * input order afterwards, so the answer — including the breakdown's order —
 * is the same as a serial scan's whichever call finishes first.
 */
export async function scanRepositories(
  reposBeingScanned: string[],
  opts: { detail?: boolean; perRepo?: boolean; timings?: ScanTimings; limiter?: Limiter } = {},
): Promise<{ bytes: number; blobs: number; incomplete: boolean; perBlob?: Map<string, BlobFacts>; perRepo?: Map<string, RepoUsage> }> {
  const { timings, limiter } = opts;
  const concurrency = storageScanConcurrency();
  const timed = async <T>(phase: keyof ScanTimings, fn: () => Promise<T>): Promise<T> => {
    const measured = async (): Promise<T> => {
      if (!timings) return fn();
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        timings[phase] += Date.now() - t0;
      }
    };
    return limiter ? limiter(measured) : measured();
  };

  // Any non-404 failure below means a repo/manifest/blob couldn't be read, so
  // the byte total under-counts — track that so the push-gate can fail closed.
  let incomplete = false;
  // The repositories a failure is attributable to, for the per-repo breakdown.
  const incompleteRepos = new Set<string>();
  const markIncomplete = (repo: string): void => { incomplete = true; incompleteRepos.add(repo); };

  // Phase 1: each repo's tags.
  const tagLists = await mapWithConcurrency(reposBeingScanned, concurrency, async (repo) => {
    try {
      return (await timed('tagsMs', () => listTags(repo))).tags;
    } catch (err) {
      if (!isNotFound(err)) markIncomplete(repo);
      logger.warn('Tag list failed during storage rollup', {
        repo, error: errorMessage(err),
      });
      return [] as string[];
    }
  });

  // Phase 2: each tag's manifest → the blob digests it references (null when
  // it could not be read).
  const jobs = reposBeingScanned.flatMap((repo, i) => tagLists[i]!.map((tag) => ({ repo, tag })));
  const jobDigests = await mapWithConcurrency(jobs, concurrency, async ({ repo, tag }): Promise<Set<string> | null> => {
    try {
      const { body } = await timed('manifestsMs', () => getManifest(repo, tag));
      const digests = new Set<string>();
      collectBlobDigests(body, digests);
      // Multi-arch index: fetch each child and collect its config+layer
      // blobs — otherwise a multi-arch image's actual layer bytes go
      // UNCOUNTED and the storage push-gate (isStorageOverBudget) is
      // bypassable. A failed child fetch marks the rollup incomplete
      // (fail-closed) but doesn't abort the remaining children. Children are
      // fetched in order within the job, so the digest order is the serial one.
      for (const childDigest of indexChildDigests(body)) {
        try {
          const { body: childBody } = await timed('manifestsMs', () => getManifest(repo, childDigest));
          collectBlobDigests(childBody, digests);
        } catch (childErr) {
          if (!isNotFound(childErr)) {
            markIncomplete(repo);
            logger.warn('Child manifest fetch failed during storage rollup', {
              repo, tag, childDigest, error: errorMessage(childErr),
            });
          }
        }
      }
      return digests;
    } catch (err) {
      if (!isNotFound(err)) {
        markIncomplete(repo);
        logger.warn('Manifest fetch failed during storage rollup', {
          repo, tag, error: errorMessage(err),
        });
      }
      return null;
    }
  });

  // Map each unique blob digest → EVERY repo known to reference it. Docker
  // Distribution scopes blob access per-repo (`/v2/<repo>/blobs/<digest>`), so a
  // blob must be HEAD'd against a repo that actually has it; HEADing every digest
  // against a single repo 404s (and silently drops) blobs that live elsewhere,
  // systematically undercounting multi-repo orgs. We keep ALL referencing repos
  // (not just the first) so a blob HEAD that 404s on one repo can be re-resolved
  // against another referencing repo before the byte is written off.
  //
  // Per-TAG references, for the marginal-size breakdown only. The rollup needs
  // blob → repos (to resolve a HEAD); a breakdown needs blob → tags, because
  // "bytes freed if this version goes" is the sum of the blobs referenced by
  // that tag AND BY NOTHING ELSE. Collected in the same walk so a breakdown
  // costs one scan rather than two. Built here, in input order.
  const blobRepos = new Map<string, string[]>();
  const blobTags = opts.detail ? new Map<string, string[]>() : null;
  const push = (m: Map<string, string[]>, k: string, v: string): void => {
    const list = m.get(k);
    if (!list) m.set(k, [v]);
    else if (!list.includes(v)) list.push(v);
  };
  jobs.forEach(({ repo, tag }, i) => {
    for (const d of jobDigests[i] ?? []) {
      push(blobRepos, d, repo);
      if (blobTags) push(blobTags, d, tagRef(repo, tag));
    }
  });

  // Phase 3: HEAD each unique blob, against a repo that references it. The
  // HEAD is cheap (no body transfer), but with hundreds of unique layers per org
  // this adds up; the cache amortizes that across subsequent calls.
  const blobEntries = [...blobRepos.entries()];
  const sizes = await mapWithConcurrency(blobEntries, concurrency, async ([digest, repos]): Promise<number | null> => {
    for (const repo of repos) {
      try {
        const head = await timed('blobHeadsMs', () => headBlob(repo, digest));
        // A 200 with no `Content-Length` is NOT a measurement. Marking the blob
        // counted here added zero bytes while telling the rollup it was
        // complete, so the total silently under-counted and the fail-closed
        // push gate — whose whole job is to refuse when it cannot prove the org
        // is under budget — waved the push through. Treat it like any other
        // repo that could not answer: try the next one, and if none can, fall
        // through to the unmeasured branch and mark the rollup incomplete.
        if (typeof head.contentLength !== 'number') {
          logger.warn('Blob HEAD returned no Content-Length during storage rollup', { digest, repo });
          continue;
        }
        return head.contentLength; // measured once against a repo that has it
      } catch (err) {
        if (isNotFound(err)) {
          // This repo doesn't have the blob — try the next referencing repo
          // rather than silently dropping the bytes (the old undercount bug).
          continue;
        }
        // A non-404 error means the registry couldn't answer; we can't prove the
        // byte total is complete → fail closed.
        logger.warn('Blob HEAD failed during storage rollup', {
          digest, repo, error: errorMessage(err),
        });
        break;
      }
    }
    // Every referencing repo 404'd (blob genuinely unresolvable) or a non-404
    // error stopped us: the total now under-counts, so mark the rollup
    // incomplete and let the fail-closed push-gate treat it as inconclusive.
    logger.warn('Blob unmeasurable during storage rollup (all referencing repos 404 or errored)', {
      digest, repos,
    });
    return null;
  });

  let totalBytes = 0;
  const perBlob = blobTags ? new Map<string, BlobFacts>() : null;
  // Each unique blob is billed to ONE repository — the first in input order that
  // references it — so the per-repo figures sum to the deduplicated total.
  const perRepo = opts.perRepo
    ? new Map<string, RepoUsage>(reposBeingScanned.map((repo) => [repo, { bytes: 0, blobs: 0, incomplete: false }]))
    : null;
  blobEntries.forEach(([digest, repos], i) => {
    const size = sizes[i];
    const owner = perRepo?.get(repos[0]!);
    if (owner) owner.blobs++;
    if (size === null || size === undefined) {
      markIncomplete(repos[0]!);
      return;
    }
    totalBytes += size;
    if (owner) owner.bytes += size;
    // Only a MEASURED blob enters the breakdown. An unmeasurable one is
    // already marked incomplete, and attributing 0 bytes to it would
    // under-promise a prune rather than say the figure is partial.
    if (perBlob) perBlob.set(digest, { size, refs: blobTags!.get(digest) ?? [] });
  });

  if (perRepo) for (const repo of incompleteRepos) { const r = perRepo.get(repo); if (r) r.incomplete = true; }

  return { bytes: totalBytes, blobs: blobRepos.size, incomplete, ...(perBlob ? { perBlob } : {}), ...(perRepo ? { perRepo } : {}) };
}

/** Force-evict a cached rollup so the next call recomputes. Used by the
 *  GC endpoint after pruning so the dashboard shows the freed bytes. */
export function invalidateStorageCache(prefix: string): void {
  cache.delete(prefix);
  // An org namespace's bytes are also part of that org's combined rollup AND
  // its per-version breakdown — the prune view would otherwise keep offering
  // the versions just deleted until the breakdown's TTL ran out.
  const org = /^org-([a-z0-9-]+)\/$/.exec(prefix);
  if (org) invalidateOrgStorageCache(org[1]!);
}

/** Called with an org id whenever that org's stored bytes may have changed. */
type OrgStorageListener = (orgId: string) => void;
const orgStorageListeners: OrgStorageListener[] = [];

/**
 * Subscribe to org invalidations. The storage snapshot uses it to re-measure
 * an org after a delete or prune, so freed bytes show before the next full run.
 * (A hook rather than an import: the snapshot module builds on this one.)
 */
export function onOrgStorageInvalidated(fn: OrgStorageListener): void {
  orgStorageListeners.push(fn);
}

/** Evict one org's per-version breakdown and tell listeners its bytes changed. */
export function invalidateOrgStorageCache(orgId: string): void {
  const key = `${ORG_BREAKDOWN_KEY}${orgId}`;
  breakdownCache.delete(key);
  // A computation already running measured the PRE-change registry: let it
  // finish for whoever awaits it, but neither cache it nor hand it to the next
  // caller.
  breakdownGeneration.set(key, (breakdownGeneration.get(key) ?? 0) + 1);
  breakdownInflight.delete(key);
  for (const fn of orgStorageListeners) {
    try {
      fn(orgId);
    } catch (err) {
      logger.warn('Org storage invalidation listener failed', { orgId, error: errorMessage(err) });
    }
  }
}

/**
 * Add the config + layer blob digests of an image manifest to `out`. An index
 * contributes nothing here: its children are MANIFESTS, which the registry
 * links under the repository's manifest revisions, not its layers — a blob
 * HEAD for one answers 404 in every repository, which made every multi-arch
 * rollup (every BuildKit image with provenance) `incomplete`. The caller
 * fetches each child (see {@link indexChildDigests}) and collects ITS blobs.
 * Manifest JSON itself is not counted, single-arch or index.
 */
function collectBlobDigests(body: unknown, out: Set<string>): void {
  if (typeof body !== 'object' || body === null) return;
  const b = body as Record<string, unknown>;
  const configDigest = (b.config as { digest?: string } | undefined)?.digest;
  if (configDigest) out.add(configDigest);
  const layers = b.layers as Array<{ digest: string }> | undefined;
  if (Array.isArray(layers)) {
    for (const l of layers) if (l.digest) out.add(l.digest);
  }
}

/** Child manifest digests referenced by a multi-arch index (`manifests[].digest`);
 *  empty for a single-arch image. The caller fetches each so the
 *  per-architecture config+layer blobs are counted. */
function indexChildDigests(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const children = (body as Record<string, unknown>).manifests as Array<{ digest?: string }> | undefined;
  if (!Array.isArray(children)) return [];
  return children.map((c) => c.digest).filter((d): d is string => typeof d === 'string');
}
