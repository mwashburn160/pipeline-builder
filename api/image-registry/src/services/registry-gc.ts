// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '@pipeline-builder/api-server';
import { emitImageRegistryAudit } from './audit.js';
import { INDEX_MEDIA_TYPES, isIndex } from './manifest.js';
import {
  listRepositoriesUnderPrefix,
  listTags,
  getManifest,
  getBlobJson,
  deleteManifest,
  isNotFound,
} from './registry-client.js';
import { computeStorageUsage, invalidateStorageCache } from './storage-usage.js';
import { repoOwnerOrgId } from '../routes/images/repo-access.js';

const logger = createLogger('registry-gc');

/**
 * Tag names treated as mutable "floating" pointers that operators re-point at
 * a known-good build (which may be an OLD build). A digest carrying one of
 * these tags is NEVER age-deleted — see the retention note on `runRegistryGc`.
 * Override the set via `REGISTRY_GC_PROTECTED_TAGS` (comma-separated).
 */
const DEFAULT_PROTECTED_TAGS = [
  'latest', 'stable', 'main', 'master', 'release', 'prod', 'production', 'edge',
];

function protectedTagNames(): Set<string> {
  const raw = process.env.REGISTRY_GC_PROTECTED_TAGS;
  const names = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_PROTECTED_TAGS;
  return new Set(names.map((n) => n.toLowerCase()));
}

interface ManifestBody {
  created?: string;
  annotations?: Record<string, string>;
  config?: { digest?: string };
  /** Present on a multi-arch index / manifest list — child references by digest. */
  manifests?: Array<{ digest?: string; mediaType?: string }>;
}

/**
 * Repositories the AGE-based sweep never touches, whatever prefix it is given
 * (a short prefix like `p` or `` would otherwise reach them):
 *
 *  - `public/*` — listed plugin versions. Deployed pipelines pull them BY
 *    DIGEST on every run, so build age means nothing; a public image is deleted
 *    only when it was yanked more than 180 days ago AND no step manifest
 *    references it — a decision only the plugin service (which owns the step
 *    manifests) can make. It hands such digests over one at a time through
 *    `POST /internal/plugin-publications/gc` (plugin ecosystem G40).
 *  - `registry-meta/*` — the publication records (public-publications.ts).
 */
export function isAgeGcExempt(repo: string): boolean {
  return repo.startsWith('public/') || repo.startsWith('registry-meta/');
}

export interface GcOptions {
  /** Repo namespace prefix to GC (e.g. `org-acme/`). Required — full-registry GC is not exposed. */
  prefix: string;
  /** Manifests older than this many days are eligible. Default 30. */
  maxAgeDays?: number;
  /**
   * Dry-run mode: walks the repos + identifies candidates without issuing
   * DELETEs. Logs the count + sample so an operator can validate before
   * flipping to a real run.
   */
  dryRun?: boolean;
  /**
   * Audit attribution. The admin `POST /api/admin/gc` route passes the calling
   * sysadmin's id/email; the in-process scheduler sweep runs with no request
   * user, so `actorId` defaults to `'system'` on the emitted `registry.gc`
   * audit event.
   */
  actorId?: string;
  actorEmail?: string;
}

export interface GcResult {
  /** Number of repos walked under `prefix`. */
  reposScanned: number;
  /** Number of manifests considered for pruning across all repos. */
  candidates: number;
  /**
   * Number of manifests actually deleted. Always 0 in dry-run mode.
   * Distribution's GC reconciles the blob store on its own schedule, so
   * the bytes-on-disk number only drops when the registry's `garbage-collect`
   * command runs (operator-driven, separate from this app-level GC).
   */
  deleted: number;
  /** Per-repo breakdown for the operator's run log. */
  perRepo: Array<{ repo: string; scanned: number; deleted: number }>;
}

/**
 * Resolve the effective creation timestamp for a manifest, following the
 * config blob and — for a multi-arch INDEX — descending into a child.
 *
 * An index manifest carries NO `created`/annotation and NO `config` of its
 * own (it's just a list of per-arch child manifests), so the naive lookup
 * always came up empty and every multi-arch image was skipped forever. Here
 * we descend into the first child image manifest and read ITS config
 * `created`, so index manifests become age-eligible for GC. `depth` guards
 * against a pathological index-of-index cycle.
 */
async function resolveCreated(
  repo: string,
  body: ManifestBody | undefined,
  mediaType: string | undefined,
  depth = 0,
): Promise<string | undefined> {
  if (isIndex(mediaType, body) && depth < 2) {
    const children = body?.manifests ?? [];
    // Prefer an image manifest child (skip nested attestation/index entries).
    const child = children.find((m) => m.digest && !INDEX_MEDIA_TYPES.has(m.mediaType ?? ''))
      ?? children.find((m) => m.digest);
    if (child?.digest) {
      try {
        const cm = await getManifest(repo, child.digest);
        return await resolveCreated(repo, cm.body as ManifestBody, cm.mediaType, depth + 1);
      } catch (err) {
        logger.debug('GC: index child manifest fetch for created failed', {
          repo, child: child.digest, error: errorMessage(err),
        });
        return undefined;
      }
    }
    return undefined;
  }

  let created = body?.created ?? body?.annotations?.['org.opencontainers.image.created'];
  if (!created && body?.config?.digest) {
    try {
      const cfg = await getBlobJson<{ created?: string }>(repo, body.config.digest);
      created = cfg?.created;
    } catch (err) {
      logger.debug('GC: config blob fetch for created failed', {
        repo, error: errorMessage(err),
      });
    }
  }
  return created;
}

/**
 * Application-level registry GC. Walks every repo under `prefix` and, for
 * each repo, lists tags; for each tag, fetches the manifest and resolves its
 * `created` timestamp (descending into a multi-arch index's child config when
 * the index itself carries no timestamp). Manifests older than `maxAgeDays`
 * are deleted by digest — SUBJECT TO the retention safeguards below.
 *
 * RETENTION SAFETY (why we don't just delete by embedded build time):
 * `created` is the image BUILD time, not when the tag was pushed / last moved.
 * Re-pointing a floating tag (`stable`, `latest`, …) at a known-good OLD build
 * would otherwise make GC delete a live, intentionally-pinned tag — data loss.
 * The registry v2 API exposes no tag push/mutation time, so we fail safe:
 *   - a digest carrying a floating/protected tag name
 *     ({@link DEFAULT_PROTECTED_TAGS}, override via `REGISTRY_GC_PROTECTED_TAGS`)
 *     is NEVER age-deleted;
 *   - a digest carrying MORE THAN ONE tag (a version tag co-located with a
 *     re-pointed pin) is NEVER age-deleted;
 *   - a child manifest referenced by a currently-tagged index is NEVER
 *     deleted (a live index still needs it).
 * A digest is deleted at most once even when several stale tags share it.
 * (Genuinely stale single immutable version tags past the cutoff are still
 * pruned; only mutation-prone / shared / index-referenced digests are spared.)
 *
 * KNOWN GAP (not fixable from this service): a single immutable version tag that
 * is OLD but still PINNED by an active plugin record is currently eligible for
 * age-deletion — the plugin registry (which maps `org-<id>/<name>:<version>` →
 * an active plugin row) lives in the plugins Postgres table and is NOT reachable
 * from image-registry (no pipeline-data dependency, no plugin-service endpoint
 * exposing active image references). Closing it requires a cross-service
 * integration: either (a) an authenticated api/plugin endpoint returning the set
 * of active `(repo, version)` references for a namespace prefix that this GC
 * consults before deleting, or (b) a "last-resolved" signal persisted per image
 * tag. Both are out of scope for this service's boundary — see the agent report.
 *
 * NOTE: This deletes the *manifest reference*. The underlying registry's
 * blob garbage-collector (`registry garbage-collect`) is what frees the
 * bytes on disk. That's a separate operator action — usually scheduled
 * weekly off-peak; we don't drive it from this app.
 *
 * Used by both:
 *  - the in-process scheduler (`gc-scheduler.ts`, opt-in via
 *    `REGISTRY_GC_ENABLED=true`) that sweeps every `org-*` namespace
 *    (default every 24h), AND
 *  - the admin `POST /api/admin/gc` endpoint for manual one-off runs.
 */
export async function runRegistryGc(opts: GcOptions): Promise<GcResult> {
  const { prefix, maxAgeDays = 30, dryRun = false, actorId, actorEmail } = opts;
  // defense-in-depth: prefix is required by callers (Zod-validated at the
  // route layer, but this function is also invoked directly by the
  // in-process scheduler).
  if (!prefix) throw new Error('prefix is required');

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const protectedTags = protectedTagNames();
  const perRepo: GcResult['perRepo'] = [];
  let candidates = 0;
  let deleted = 0;

  // Walk the catalog and collect repos under `prefix` — never the public
  // namespace or this service's bookkeeping (see isAgeGcExempt).
  const repos = (await listRepositoriesUnderPrefix(prefix)).filter((r) => !isAgeGcExempt(r));

  for (const repo of repos) {
    let scanned = 0;
    let repoDeleted = 0;
    try {
      const { tags } = await listTags(repo);

      // PASS 1 — resolve every tag to its manifest and build the reference
      // maps we need BEFORE deleting anything (deletes are by-digest and
      // destroy every tag on that digest, so the retention decision must see
      // the whole repo first). Dedup by digest so a manifest reached via
      // several tags is fetched/aged once.
      interface ManifestInfo {
        digest: string;
        mediaType: string;
        body: ManifestBody;
        tags: string[];
      }
      const byDigest = new Map<string, ManifestInfo>();
      const referencedByLiveIndex = new Set<string>();

      for (const tag of tags) {
        scanned++;
        let mani;
        try {
          mani = await getManifest(repo, tag);
        } catch (err) {
          if (isNotFound(err)) continue;
          logger.warn('GC: manifest fetch failed', {
            repo, tag, error: errorMessage(err),
          });
          continue;
        }
        const body = mani.body as ManifestBody;
        const existing = byDigest.get(mani.digest);
        if (existing) {
          existing.tags.push(tag);
        } else {
          byDigest.set(mani.digest, {
            digest: mani.digest, mediaType: mani.mediaType, body, tags: [tag],
          });
        }
        // A live (tagged) index protects its child manifests from deletion.
        if (isIndex(mani.mediaType, body)) {
          for (const child of body.manifests ?? []) {
            if (child.digest) referencedByLiveIndex.add(child.digest);
          }
        }
      }

      // PASS 2 — decide + apply deletions, one pass per UNIQUE digest.
      for (const info of byDigest.values()) {
        // Determine creation time (descends into an index's child config).
        // Emit a counter when no age is resolvable so operators can spot the
        // manifests we silently skip.
        const created = await resolveCreated(repo, info.body, info.mediaType);
        if (!created) {
          incCounter('gc_skipped_no_timestamp_total', { reason: 'no_created' });
          continue;
        }
        const ts = Date.parse(created);
        if (!Number.isFinite(ts) || ts > cutoffMs) continue;

        // RETENTION SAFEGUARDS (see runRegistryGc doc): never age-delete a
        // digest that is pinned by a floating tag, shared by multiple tags,
        // or referenced by a live index. Build time being old is NOT enough.
        const hasProtectedTag = info.tags.some((t) => protectedTags.has(t.toLowerCase()));
        const isMultiTagged = info.tags.length > 1;
        const isIndexChild = referencedByLiveIndex.has(info.digest);
        if (hasProtectedTag || isMultiTagged || isIndexChild) {
          incCounter('gc_skipped_protected_total', {
            reason: hasProtectedTag ? 'floating_tag' : isMultiTagged ? 'multi_tagged' : 'index_child',
          });
          logger.debug('GC: retained protected digest', {
            repo, digest: info.digest, tags: info.tags, isIndexChild,
          });
          continue;
        }

        candidates++;
        if (dryRun) {
          logger.info('GC dry-run candidate', { repo, tags: info.tags, digest: info.digest, created });
          continue;
        }

        try {
          await deleteManifest(repo, info.digest);
          repoDeleted++;
          deleted++;
        } catch (err) {
          logger.warn('GC: delete failed', {
            repo, tags: info.tags, digest: info.digest, error: errorMessage(err),
          });
        }
      }
    } catch (err) {
      logger.warn('GC: tag list failed', { repo, error: errorMessage(err) });
    }
    perRepo.push({ repo, scanned, deleted: repoDeleted });
  }

  if (deleted > 0) invalidateStorageCache(prefix);

  // Audit the destructive sweep AFTER the deletes land. Only a real run that
  // actually pruned something is a data-loss event worth a durable trail — a
  // dry-run mutates nothing, and a 0-delete real run is a no-op. Fire-and-
  // forget; never blocks or fails the sweep. `actorId` is 'system' for the
  // scheduler path (no request user). Details carry counts + the org namespace
  // (no secrets / AWS account ids).
  if (!dryRun && deleted > 0) {
    const affectedOrgId = repoOwnerOrgId(prefix);
    emitImageRegistryAudit({
      action: 'registry.gc',
      actorId: actorId ?? 'system',
      ...(actorEmail && { actorEmail }),
      // The org whose namespace was pruned (so its admins see the sweep).
      ...(affectedOrgId && { affectedOrgId }),
      outcome: 'success',
      targetType: 'registry-namespace',
      targetId: prefix,
      details: {
        prefix,
        reposScanned: repos.length,
        candidates,
        deleted,
        maxAgeDays,
      },
    });
  }

  return {
    reposScanned: repos.length,
    candidates,
    deleted,
    perRepo,
  };
}

// -----------------------------------------------------------------------------
// Quarantine namespace (anonymous plugin submissions, plugin ecosystem §4.2 / W5)
// -----------------------------------------------------------------------------

/** Namespace prefix of the anonymous-submission builds. */
export const QUARANTINE_PREFIX = 'quarantine/';

/**
 * Quarantined artifacts live 30 days (plan §8 retention, G46) — the same window
 * as the quarantine bucket's lifecycle expiry and a pending submission's
 * `expires_at`. A repo whose NEWEST image is older than this is deleted whole.
 */
export const QUARANTINE_MAX_AGE_DAYS = 30;

/** Counter: quarantine repos deleted, by reason (`requested` = plugin hook, `expired` = age sweep). */
export const QUARANTINE_DELETED_COUNTER = 'registry_quarantine_repositories_deleted_total';
/** Gauge: quarantine repos currently in the registry (refreshed by each sweep). */
export const QUARANTINE_REPOS_GAUGE = 'registry_quarantine_repositories';
/** Gauge: unique blob bytes under `quarantine/*` (refreshed by each sweep; never tenant-billed). */
export const QUARANTINE_STORAGE_GAUGE = 'registry_quarantine_storage_bytes';

export interface QuarantineDeleteResult {
  repository: string;
  /** Unique manifest digests deleted (image, index, cosign signature/attestation). */
  deleted: number;
}

/**
 * Delete EVERY manifest in `quarantine/<submissionId>` — the image, any
 * multi-arch children and the cosign signature/attestation manifests (they are
 * tags too). Idempotent: a repo that is already gone deletes nothing. The
 * registry's own `garbage-collect` frees the blob bytes afterwards (as for
 * every other app-level GC delete).
 *
 * The plugin service calls this (through `DELETE /internal/quarantine/:id`)
 * when a submission reaches a terminal state — rejected, gate_failed, expired
 * or approved (after the publish copied it to `public/community/<name>`) — and
 * the age sweep below is the backstop for a missed call.
 */
export async function deleteQuarantineRepository(repository: string, reason: 'requested' | 'expired'): Promise<QuarantineDeleteResult> {
  if (!repository.startsWith(QUARANTINE_PREFIX)) throw new Error(`Not a quarantine repository: ${repository}`);
  let tags: string[];
  try {
    tags = (await listTags(repository)).tags ?? [];
  } catch (err) {
    if (isNotFound(err)) return { repository, deleted: 0 };
    throw err;
  }
  const digests = new Set<string>();
  const children = new Set<string>();
  for (const tag of tags) {
    try {
      const m = await getManifest(repository, tag);
      digests.add(m.digest);
      if (isIndex(m.mediaType, m.body as ManifestBody)) {
        for (const c of (m.body as ManifestBody).manifests ?? []) if (c.digest) children.add(c.digest);
      }
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  let deleted = 0;
  // Indexes first, then their children: a child is only unreferenced once its
  // index is gone (Distribution tolerates either order; this keeps it tidy).
  for (const digest of [...digests, ...[...children].filter((d) => !digests.has(d))]) {
    try {
      await deleteManifest(repository, digest);
      deleted++;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  if (deleted > 0) {
    incCounter(QUARANTINE_DELETED_COUNTER, { reason });
    invalidateStorageCache(QUARANTINE_PREFIX);
  }
  return { repository, deleted };
}

export interface QuarantineGcResult {
  reposScanned: number;
  deleted: number;
  /** Repos kept because no image in them carried a resolvable build time. */
  skippedNoTimestamp: number;
}

/**
 * Age sweep over `quarantine/*`: delete every repo whose NEWEST image was built
 * more than `maxAgeDays` ago. Unlike the org sweep there are no retention
 * safeguards to honour — nothing pins a quarantined image (it is pulled only by
 * the plugin service, for moderation and the approval copy) — so the unit of
 * deletion is the whole repo. A repo with no resolvable build time is kept and
 * counted; the plugin service's terminal-state hook still removes it.
 */
export async function runQuarantineGc(opts: { maxAgeDays?: number; dryRun?: boolean } = {}): Promise<QuarantineGcResult> {
  const { maxAgeDays = QUARANTINE_MAX_AGE_DAYS, dryRun = false } = opts;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const repos = await listRepositoriesUnderPrefix(QUARANTINE_PREFIX);
  let deleted = 0;
  let skippedNoTimestamp = 0;
  let remaining = 0;

  for (const repo of repos) {
    let newest: number | null = null;
    let tagged = 0;
    try {
      const { tags } = await listTags(repo);
      for (const tag of tags ?? []) {
        // cosign companions (`sha256-….sig/.att`) describe an image; its age is the image's.
        if (/^sha256-[0-9a-f]{64}\.(sig|att|sbom)$/.test(tag)) continue;
        tagged++;
        try {
          const m = await getManifest(repo, tag);
          const created = await resolveCreated(repo, m.body as ManifestBody, m.mediaType);
          const ts = created ? Date.parse(created) : NaN;
          if (Number.isFinite(ts)) newest = newest === null ? ts : Math.max(newest, ts);
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }
    } catch (err) {
      if (isNotFound(err)) continue;
      logger.warn('Quarantine GC: repo scan failed', { repo, error: errorMessage(err) });
      remaining++;
      continue;
    }
    if (tagged > 0 && newest === null) {
      skippedNoTimestamp++;
      incCounter('gc_skipped_no_timestamp_total', { reason: 'quarantine_no_created' });
      remaining++;
      continue;
    }
    // An EMPTY repo (every tag already deleted) is a hollow catalog entry the
    // registry can't remove over HTTP — nothing to delete, nothing to count.
    if (tagged === 0 || newest === null || newest > cutoffMs) {
      if (tagged > 0) remaining++;
      continue;
    }
    if (dryRun) {
      logger.info('Quarantine GC dry-run candidate', { repo, newest: new Date(newest).toISOString() });
      remaining++;
      continue;
    }
    try {
      const r = await deleteQuarantineRepository(repo, 'expired');
      if (r.deleted > 0) {
        deleted++;
        emitImageRegistryAudit({
          action: 'registry.gc',
          actorId: 'system',
          affectedOrgId: SYSTEM_ORG_ID,
          outcome: 'success',
          targetType: 'registry-namespace',
          targetId: repo,
          details: { prefix: QUARANTINE_PREFIX, repo, manifestsDeleted: r.deleted, maxAgeDays, reason: 'expired' },
        });
      }
    } catch (err) {
      logger.warn('Quarantine GC: delete failed', { repo, error: errorMessage(err) });
      remaining++;
    }
  }

  setGauge(QUARANTINE_REPOS_GAUGE, {}, remaining);
  try {
    const usage = await computeStorageUsage(QUARANTINE_PREFIX, { force: true });
    if (!usage.incomplete) setGauge(QUARANTINE_STORAGE_GAUGE, {}, usage.bytes);
  } catch (err) {
    logger.warn('Quarantine GC: storage rollup failed', { error: errorMessage(err) });
  }
  if (deleted > 0) logger.info('Quarantine GC: expired submissions removed', { deleted, reposScanned: repos.length });
  return { reposScanned: repos.length, deleted, skippedNoTimestamp };
}
