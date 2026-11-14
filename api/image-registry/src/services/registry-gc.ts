// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { SYSTEM_ACTOR_ID, createLogger, errorMessage, SYSTEM_ORG_ID, recordAudit } from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '@pipeline-builder/api-server';
import { isCosignCompanionTag } from './cosign-tags.js';
import { INDEX_MEDIA_TYPES, isIndex } from './manifest.js';
import { inPublicNamespace, inQuarantineNamespace, inRegistryMetaNamespace, QUARANTINE_PREFIX, repoOwnerOrgId } from './namespaces.js';
import { pluginImageReferences } from './plugin-image-references.js';
import {
  listRepositoriesUnderPrefix,
  listTags,
  getManifest,
  getBlobJson,
  deleteManifest,
  isNotFound,
} from './registry-client.js';
import { computeStorageUsage, invalidateOrgStorageCache, invalidateStorageCache } from './storage-usage.js';

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
 *    `POST /internal/plugin-publications/gc`.
 *  - `registry-meta/*` — the publication records (public-publications.ts).
 *  - `quarantine/*` — anonymous submissions awaiting moderation. They have
 *    their own fixed 30-day bound ({@link runQuarantineGc}); a manual sweep
 *    with a shorter `maxAgeDays` would otherwise delete a submission before
 *    it is decided.
 */
export function isAgeGcExempt(repo: string): boolean {
  return inPublicNamespace(repo) || inRegistryMetaNamespace(repo) || inQuarantineNamespace(repo);
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
  /**
   * The ACTOR's org (the trail row's `orgId`). The admin route passes the
   * caller's org; the scheduler sweep is the system org acting on a tenant's
   * namespace, so it defaults to `SYSTEM_ORG_ID` — an event with no `orgId`
   * never lands in anyone's trail.
   */
  actorOrgId?: string;
}

/** Cap on the digests listed in one `registry.gc` event (the count is always exact). */
const GC_AUDIT_DIGEST_CAP = 100;

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
 * IN USE: a digest the plugin service reports as still needed by the
 * repository's org (`pluginImageReferences` — any plugin row's digest, deleted
 * ones included, and any digest a pipeline of the org or its teams declares,
 * runs or has an open deployed exposure on) is never age-deleted, however old
 * and however vulnerable. When that set cannot be read the sweep FAILS SAFE:
 * nothing in the repository is deleted this pass.
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
  const { prefix, maxAgeDays = 30, dryRun = false, actorId, actorEmail, actorOrgId } = opts;
  // defense-in-depth: prefix is required by callers (Zod-validated at the
  // route layer, but this function is also invoked directly by the
  // in-process scheduler).
  if (!prefix) throw new Error('prefix is required');

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const protectedTags = protectedTagNames();
  const perRepo: GcResult['perRepo'] = [];
  let candidates = 0;
  let deleted = 0;
  // What was deleted, for the audit row (capped at GC_AUDIT_DIGEST_CAP).
  const deletedRefs: Array<{ repo: string; digest: string; tags: string[] }> = [];

  // Walk the catalog and collect repos under `prefix` — never the public
  // namespace or this service's bookkeeping (see isAgeGcExempt).
  const repos = (await listRepositoriesUnderPrefix(prefix)).filter((r) => !isAgeGcExempt(r));

  // The digests each owner org still needs, read once per org per pass; null =
  // unreadable (that org's repositories delete nothing this pass).
  const inUseByOrg = new Map<string, ReadonlySet<string> | null>();
  const inUseFor = async (repo: string): Promise<ReadonlySet<string> | null> => {
    const owner = repoOwnerOrgId(repo);
    if (!owner) return null;
    if (!inUseByOrg.has(owner)) {
      try {
        inUseByOrg.set(owner, await pluginImageReferences(owner));
      } catch (err) {
        logger.warn('GC: in-use image references unavailable; deleting nothing for this org this pass', { org: owner, error: errorMessage(err) });
        inUseByOrg.set(owner, null);
      }
    }
    return inUseByOrg.get(owner)!;
  };

  for (const repo of repos) {
    let scanned = 0;
    let repoDeleted = 0;
    try {
      const { tags } = await listTags(repo);
      const inUse = await inUseFor(repo);

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
        // Referenced by a plugin row or a pipeline — or the references could
        // not be read (fail safe).
        const referenced = inUse === null || inUse.has(info.digest);
        if (hasProtectedTag || isMultiTagged || isIndexChild || referenced) {
          incCounter('gc_skipped_protected_total', {
            reason: hasProtectedTag ? 'floating_tag' : isMultiTagged ? 'multi_tagged' : isIndexChild ? 'index_child'
              : inUse === null ? 'references_unavailable' : 'in_use',
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
          if (deletedRefs.length < GC_AUDIT_DIGEST_CAP) deletedRefs.push({ repo, digest: info.digest, tags: info.tags });
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
    recordAudit({
      action: 'registry.gc',
      actorId: actorId ?? SYSTEM_ACTOR_ID,
      ...(actorEmail && { actorEmail }),
      orgId: actorOrgId ?? SYSTEM_ORG_ID,
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
        deletedDigests: deletedRefs,
        ...(deleted > deletedRefs.length && { deletedDigestsTruncated: true }),
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
// Quarantine namespace (anonymous plugin submissions)
// -----------------------------------------------------------------------------

/**
 * Quarantined artifacts live 30 days — the same window
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
  if (!inQuarantineNamespace(repository)) throw new Error(`Not a quarantine repository: ${repository}`);
  const result = await deleteRepositoryManifests(repository);
  if (result.deleted > 0) {
    incCounter(QUARANTINE_DELETED_COUNTER, { reason });
    invalidateStorageCache(QUARANTINE_PREFIX);
  }
  return result;
}

/**
 * Delete every manifest in ONE repository — the image, any multi-arch children
 * and the cosign signature/attestation manifests (they are tags too).
 * Idempotent: a repo that is already gone deletes nothing.
 *
 * Namespace-agnostic and therefore NOT exported: each caller is responsible for
 * proving the repository is one it may destroy. {@link deleteQuarantineRepository}
 * checks the quarantine namespace; {@link deleteOrgNamespace} checks the org's.
 */
async function deleteRepositoryManifests(repository: string): Promise<QuarantineDeleteResult> {
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
  return { repository, deleted };
}

/** What an org-namespace teardown removed, and what it deliberately kept. */
export interface OrgNamespaceDeleteResult {
  /** `org-<id>/*` repositories purged. */
  repositories: number;
  /** Unique manifest digests deleted across them. */
  deleted: number;
  /**
   * Repositories that could not be fully purged. Non-empty means bytes remain;
   * the caller should surface it rather than report a clean teardown.
   */
  failed: string[];
}

/**
 * Delete an organization's PRIVATE registry namespace (`org-<id>/*`) — used by
 * the platform's org-delete cascade, which otherwise left a deleted org's
 * images on disk forever: billed to nobody, with no tenant left to prune them
 * and scheduled GC off by default.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH, and why each one matters:
 *
 * - **`public/<handle>/*` — the org's PUBLISHED copies.** Other organizations
 *   have installed those listings and their pipelines pin those digests, so
 *   deleting them would break consumers of a marketplace listing because its
 *   publisher's account went away. Once the org is gone they are platform
 *   content, to be withdrawn through the ecosystem's own unlist/withdraw flow
 *   if that is wanted — a decision with notices attached, not a side effect of
 *   a teardown.
 * - **`system/*` and `library/*`** — platform-owned base and sample images.
 * - **`quarantine/*`** — anonymous submissions, which belong to no tenant and
 *   have their own unconditional 30-day sweep.
 *
 * The blob BYTES come back when the registry's own `garbage-collect` runs
 * (operator-driven), exactly as for the quarantine purge; what this frees
 * immediately is every reference, so nothing is served and nothing is counted.
 */
export async function deleteOrgNamespace(orgId: string): Promise<OrgNamespaceDeleteResult> {
  const prefix = `org-${orgId.toLowerCase()}/`;
  const repositories = await listRepositoriesUnderPrefix(prefix);
  const result: OrgNamespaceDeleteResult = { repositories: 0, deleted: 0, failed: [] };
  for (const repository of repositories) {
    // Belt and braces: the prefix listing should never return anything else,
    // but this function deletes, so it re-checks rather than trusting a caller.
    if (!repository.toLowerCase().startsWith(prefix)) continue;
    try {
      const one = await deleteRepositoryManifests(repository);
      result.repositories += 1;
      result.deleted += one.deleted;
    } catch (err) {
      result.failed.push(repository);
      logger.warn('Org namespace repository could not be purged', { orgId, repository, error: errorMessage(err) });
    }
  }
  if (result.deleted > 0) invalidateOrgStorageCache(orgId);
  return result;
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
        if (isCosignCompanionTag(tag)) continue;
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
        recordAudit({
          action: 'registry.gc',
          actorId: SYSTEM_ACTOR_ID,
          orgId: SYSTEM_ORG_ID,
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
