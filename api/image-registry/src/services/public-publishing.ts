// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The public plugin namespace (`public/<publisherHandle>/<name>`, plugin
 * ecosystem) — the operations behind `/internal/plugin-publications*`.
 *
 *  - publish: copy the approved digest's manifest + blobs (NOT its `.sig` /
 *    `.att` — a signature records the repository it was made for) from the
 *    publisher's private repo, sign it FRESH here with the trust tier and
 *    publisher as signed annotations, re-attest the SBOM, then tag the version.
 *  - resign: replace the signature with new annotations (tier change,
 *    suspension, transfer).
 *  - yank: remove the version TAG only. Pipelines pull by digest on every run,
 *    so the manifest and its blobs stay.
 *  - gc: delete one yanked, unreferenced digest the plugin service hands over
 *    (it alone knows the step manifests and the 180-day yank age).
 *  - verify: the signature + its annotations, cached briefly, so lookup can
 *    detect a tier edited in the database without a re-sign.
 *
 * Every mutation of one repository is serialized: in-process, and across
 * replicas through a Redis lock, so a concurrent publish + yank (or two
 * re-signs) can't interleave a signature drop with a sign. A mutation that
 * finds another replica holding the lock answers 503 and the plugin service
 * retries it.
 */

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { envInt, createEnvRedisLock, createLogger, AppError, ErrorCode, leaderLockKey, PUBLISHER_TIERS, SYSTEM_ORG_ID, withLeaderLock, type LockRedis, type PublisherTier } from '@pipeline-builder/api-core';
import { incCounter, observe, setGauge } from '@pipeline-builder/api-server';

import { cosignCompanionTags, isCosignCompanionTag } from './cosign-tags.js';
import { copyManifestTree } from './manifest-copy.js';
import {
  CosignRejectedError,
  PUBLISHER_ANNOTATION,
  TRUST_ANNOTATION,
  readSignedSbom,
  resignPublicImage,
  signPluginImage,
  verifyPluginSignature,
} from './plugin-signing.js';
import { protectedTagNames } from './protected-tags.js';
import { publicationOwner, writePublicationRecord } from './public-publications.js';
import {
  deleteManifest,
  deleteTag,
  getManifest,
  headManifest,
  isNotFound,
  listTags,
  putManifest,
} from './registry-client.js';
import { invalidateOrgStorageCache, invalidateStorageCache } from './storage-usage.js';
import { TtlCache } from './ttl-cache.js';
import { config } from '../config/index.js';

const logger = createLogger('public-publishing');


/** Metric names. */
export const PublicationMetrics = {
  PUBLISH: 'registry_public_publish_total',
  /** Seconds per publish step (`step`: source, sbom, copy, sign, tag, total), to show which one is slow. */
  PUBLISH_DURATION: 'registry_public_publish_duration_seconds',
  RESIGN: 'registry_public_resign_total',
  YANK: 'registry_public_yank_total',
  GC: 'registry_public_gc_total',
  VERIFY: 'registry_public_verify_total',
  /** Resign-job progress hook: the plugin service's job reports `completed`/`total` on each call. */
  RESIGN_JOB_COMPLETED: 'registry_public_resign_job_completed',
  RESIGN_JOB_TOTAL: 'registry_public_resign_job_total',
  /** Unix seconds of the last progress report — the "re-sign job stalled" alert watches this. */
  RESIGN_JOB_LAST_PROGRESS: 'registry_public_resign_job_last_progress_timestamp_seconds',
} as const;

/** A publish/yank/gc precondition failed (maps to 409). */
export class PublicationConflictError extends AppError {
  constructor(message: string) {
    super(409, ErrorCode.CONFLICT, message);
    this.name = 'PublicationConflictError';
  }
}

/** The named source or public manifest doesn't exist (maps to 404). */
export class PublicationNotFoundError extends AppError {
  constructor(message: string) {
    super(404, ErrorCode.NOT_FOUND, message);
    this.name = 'PublicationNotFoundError';
  }
}

/** Another replica is mutating the same repository (maps to 503: retry shortly). */
export class PublicationBusyError extends AppError {
  constructor(repository: string) {
    super(503, ErrorCode.SERVICE_UNAVAILABLE, `${repository} is being changed by another request; retry shortly`);
    this.name = 'PublicationBusyError';
  }
}

/** The source image has no verifiable signed SBOM to re-attest (maps to 409 IMAGE_VERIFICATION_FAILED). */
export class SourceVerificationError extends AppError {
  constructor(message: string) {
    super(409, ErrorCode.IMAGE_VERIFICATION_FAILED, message);
    this.name = 'SourceVerificationError';
  }
}

// -----------------------------------------------------------------------------
// Per-repository serialization
// -----------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

/**
 * The cross-replica lock. It heartbeats while a mutation runs, so the TTL is
 * only how long a crashed holder blocks the repository, not a cap on a slow
 * publish. Null when Redis isn't configured (one replica: in-process is enough).
 */
const lockRedis: LockRedis | null = createEnvRedisLock();
const REPOSITORY_LOCK_TTL_MS = 60_000;

/** Test hook: whether mutations also take the cross-replica lock. */
let crossReplicaLock: LockRedis | null = lockRedis;
export function setRepositoryLockRedisForTests(redis: LockRedis | null): void {
  crossReplicaLock = redis;
}

/** Run `fn` holding the cross-replica lock on `repository`, or refuse with 503 when another replica holds it. */
async function withCrossReplicaLock<T>(repository: string, fn: () => Promise<T>): Promise<T> {
  const redis = crossReplicaLock;
  if (!redis) return fn();
  let out: T | undefined;
  const ran = await withLeaderLock(redis, leaderLockKey('image-registry', `publication:${repository}`), REPOSITORY_LOCK_TTL_MS, async () => {
    out = await fn();
  }, { metricKey: leaderLockKey('image-registry', 'publication') });
  if (!ran) throw new PublicationBusyError(repository);
  return out as T;
}

async function withRepositoryLock<T>(repository: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(repository) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => withCrossReplicaLock(repository, fn));
  locks.set(repository, run);
  try {
    return await run;
  } finally {
    if (locks.get(repository) === run) locks.delete(repository);
  }
}

// -----------------------------------------------------------------------------
// Verify cache
// -----------------------------------------------------------------------------

export interface PublicationVerification {
  signed: boolean;
  tier: PublisherTier | null;
  publisher: string | null;
}

/**
 * Positive results only, for `PUBLIC_VERIFY_CACHE_TTL_MS` (default 60s). The
 * cache is per pod: `POST …/verify-cache/invalidate` clears the pod it lands
 * on, and every resign/yank/gc clears the pod that ran it — the TTL bounds how
 * long another replica can serve the old annotations.
 */
const VERIFY_CACHE_TTL_MS = envInt('PUBLIC_VERIFY_CACHE_TTL_MS', 60_000, { min: 1 });
const verifyCache = new TtlCache<PublicationVerification>(5000, VERIFY_CACHE_TTL_MS);

const cacheKey = (repository: string, digest: string) => `${repository}@${digest}`;

/**
 * Drop cached verifications: one image, every digest of one repository, or
 * (no arguments) everything. Returns how many entries were removed.
 */
export function invalidateVerifyCache(repository?: string, digest?: string): number {
  if (!repository) return verifyCache.clear();
  if (digest) return verifyCache.delete(cacheKey(repository, digest)) ? 1 : 0;
  return verifyCache.deleteWhere((key) => key.startsWith(`${repository}@`));
}

function isPublisherTier(v: unknown): v is PublisherTier {
  return typeof v === 'string' && (PUBLISHER_TIERS as readonly string[]).includes(v);
}

/**
 * Verify `repository@digest` against the plugin-signing key and read its
 * `pb.trust` / `pb.publisher` annotations. Only signatures made FOR this
 * repository and digest count. If the verified signatures disagree (or lack
 * either annotation), `tier`/`publisher` are null — lookup refuses rather than
 * pick one.
 */
export async function verifyPublication(repository: string, digest: string): Promise<PublicationVerification> {
  const key = cacheKey(repository, digest);
  const hit = verifyCache.get(key);
  if (hit) {
    incCounter(PublicationMetrics.VERIFY, { result: hit.tier ? 'signed' : 'mismatch', cache: 'hit' });
    return hit;
  }

  const signatures = (await verifyPluginSignature(repository, digest)).filter((s) =>
    (!s.manifestDigest || s.manifestDigest === digest)
    && (!s.dockerReference || s.dockerReference === repository
      || s.dockerReference === `${config.registry.host}:${config.registry.port}/${repository}`));

  let result: PublicationVerification;
  if (signatures.length === 0) {
    result = { signed: false, tier: null, publisher: null };
  } else {
    const tiers = new Set(signatures.map((s) => s.annotations[TRUST_ANNOTATION]));
    const publishers = new Set(signatures.map((s) => s.annotations[PUBLISHER_ANNOTATION]));
    const [tier] = [...tiers];
    const [publisher] = [...publishers];
    result = tiers.size === 1 && publishers.size === 1 && isPublisherTier(tier) && typeof publisher === 'string' && publisher
      ? { signed: true, tier, publisher }
      : { signed: true, tier: null, publisher: null };
  }

  incCounter(PublicationMetrics.VERIFY, { result: !result.signed ? 'unsigned' : result.tier ? 'signed' : 'mismatch', cache: 'miss' });
  // Cache only a fully-verified result: a negative one would outlive the
  // publish or re-sign that fixes it.
  if (result.signed && result.tier) {
    verifyCache.set(key, result);
  }
  return result;
}

// -----------------------------------------------------------------------------
// Operations
// -----------------------------------------------------------------------------

function annotationsFor(tier: PublisherTier, publisherHandle: string): Record<string, string> {
  return { [TRUST_ANNOTATION]: tier, [PUBLISHER_ANNOTATION]: publisherHandle };
}

function afterMutation(repository: string, digest: string, orgIds: Array<string | null | undefined>): void {
  invalidateVerifyCache(repository, digest);
  invalidateStorageCache('public/');
  for (const org of orgIds) if (org) invalidateOrgStorageCache(org);
}

export interface PublishParams {
  sourceRepository: string;
  digest: string;
  publisherHandle: string;
  name: string;
  version: string;
  tier: PublisherTier;
  publisherOrgId: string | null;
}

export interface PublishResult {
  imageRepository: string;
  digest: string;
  /** The version tag already pointed at this digest (an idempotent re-publish). */
  alreadyPublished: boolean;
}

/**
 * Copy `sourceRepository@digest` to `public/<handle>/<name>`, sign it fresh
 * with the tier annotations, re-attest its SBOM, and tag `version`.
 *
 * The SBOM re-attested is READ FROM THE SOURCE'S SIGNED ATTESTATION (verified
 * against the plugin-signing key), not taken from the caller: the public copy
 * then carries exactly the SBOM the platform generated at build time.
 *
 * Order matters: the manifest is copied by digest (untagged), signed, and only
 * then tagged — a visible version tag always has a signature. Immutable: a
 * version tag that already points at a DIFFERENT digest is a 409; the same
 * digest re-signs (idempotent, and repairs a publish that failed mid-way).
 */
export async function publishPublicImage(p: PublishParams): Promise<PublishResult> {
  const target = `public/${p.publisherHandle}/${p.name}`;
  const started = Date.now();
  let stepStarted = started;
  const steps: Record<string, number> = {};
  /** Close the current step: record its seconds and start the next. */
  const lap = (step: string): void => {
    const now = Date.now();
    steps[step] = now - stepStarted;
    observe(PublicationMetrics.PUBLISH_DURATION, { step }, (now - stepStarted) / 1000);
    stepStarted = now;
  };
  return withRepositoryLock(target, async () => {
    stepStarted = Date.now();
    const existing = await headManifest(target, p.version);
    if (existing && existing.digest !== p.digest) {
      throw new PublicationConflictError(`${target}:${p.version} is already published as ${existing.digest}; a listed version is immutable`);
    }

    let source;
    try {
      source = await getManifest(p.sourceRepository, p.digest);
    } catch (err) {
      if (isNotFound(err)) throw new PublicationNotFoundError(`No manifest ${p.digest} in ${p.sourceRepository}`);
      throw err;
    }
    lap('source');

    let sbom: Record<string, unknown>;
    try {
      sbom = await readSignedSbom(p.sourceRepository, p.digest);
    } catch (err) {
      if (err instanceof CosignRejectedError) {
        throw new SourceVerificationError(`${p.sourceRepository}@${p.digest} has no SBOM attestation signed by the platform; rebuild it before publishing`);
      }
      throw err;
    }

    lap('sbom');

    await copyManifestTree(source, p.sourceRepository, target, p.digest);
    await writePublicationRecord(target, p.publisherOrgId);
    lap('copy');
    // `signPluginImage` attests from a FILE (cosign's `--predicate`), so the
    // document this read out of the source attestation is written down here.
    // Removed in the `finally` whatever happens: an SBOM left behind is a disk
    // leak and a stray copy of a tenant's dependency inventory.
    const sbomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-publish-sbom-'));
    const sbomPath = path.join(sbomDir, 'sbom.spdx.json');
    try {
      fs.writeFileSync(sbomPath, JSON.stringify(sbom));
      await signPluginImage({ repository: target, digest: p.digest, sbomPath, annotations: annotationsFor(p.tier, p.publisherHandle) });
    } finally {
      fs.rmSync(sbomDir, { recursive: true, force: true });
    }
    lap('sign');
    if (!existing) await putManifest(target, p.version, source.raw, source.mediaType);
    lap('tag');

    afterMutation(target, p.digest, [p.publisherOrgId]);
    const totalMs = Date.now() - started;
    observe(PublicationMetrics.PUBLISH_DURATION, { step: 'total' }, totalMs / 1000);
    logger.info('Published plugin image', { target, digest: p.digest, version: p.version, tier: p.tier, alreadyPublished: !!existing, durationMs: totalMs, stepMs: steps });
    return { imageRepository: target, digest: p.digest, alreadyPublished: !!existing };
  });
}

export interface ResignParams {
  imageRepository: string;
  digest: string;
  publisherHandle: string;
  tier: PublisherTier;
  /** When present (string or null), re-point the storage attribution (ownership transfer). */
  publisherOrgId?: string | null;
}

/** Replace the signature of a published image with new annotations. Idempotent. */
export async function resignPublicImageOp(p: ResignParams): Promise<void> {
  await withRepositoryLock(p.imageRepository, async () => {
    if (!await headManifest(p.imageRepository, p.digest)) {
      throw new PublicationNotFoundError(`No manifest ${p.digest} in ${p.imageRepository}`);
    }
    await resignPublicImage(p.imageRepository, p.digest, annotationsFor(p.tier, p.publisherHandle));
    // On a transfer the PREVIOUS owner's storage rollup also counted this
    // repository — invalidate it too, or it keeps billing for up to a cache TTL.
    let previousOwner: string | null = null;
    if (p.publisherOrgId !== undefined) {
      previousOwner = await publicationOwner(p.imageRepository).catch(() => null);
      await writePublicationRecord(p.imageRepository, p.publisherOrgId);
    }
    afterMutation(p.imageRepository, p.digest, [p.publisherOrgId, previousOwner]);
  });
}

/** Report a re-sign job's progress (the job itself runs in the plugin service). */
export function reportResignProgress(progress: { completed: number; total: number }): void {
  setGauge(PublicationMetrics.RESIGN_JOB_COMPLETED, {}, progress.completed);
  setGauge(PublicationMetrics.RESIGN_JOB_TOTAL, {}, progress.total);
  setGauge(PublicationMetrics.RESIGN_JOB_LAST_PROGRESS, {}, Math.floor(Date.now() / 1000));
}

/**
 * Remove the `version` tag of `imageRepository` — never the manifest or its
 * blobs. Idempotent: an already-removed tag succeeds (`alreadyYanked`). A tag
 * that points at a different digest than the caller named is a 409 (the caller
 * is working from a stale view; nothing is removed).
 */
export async function yankPublicVersion(imageRepository: string, version: string, digest: string): Promise<{ alreadyYanked: boolean }> {
  return withRepositoryLock(imageRepository, async () => {
    const current = await headManifest(imageRepository, version);
    if (!current) return { alreadyYanked: true };
    if (current.digest !== digest) {
      throw new PublicationConflictError(`${imageRepository}:${version} points at ${current.digest}, not ${digest}; nothing yanked`);
    }
    await deleteTag(imageRepository, version);
    afterMutation(imageRepository, digest, []);
    return { alreadyYanked: false };
  });
}

/**
 * Put the `version` tag back on `digest` — the unyank of {@link yankPublicVersion}.
 * The manifest never left `public/*` (a yank removes only the tag), so this
 * needs nothing from the publisher's own namespace. Idempotent: a tag already
 * on the digest succeeds (`alreadyTagged`); a tag on a DIFFERENT digest is a
 * 409 (a listed version is immutable); a digest that is gone is a 404.
 */
export async function retagPublicVersion(imageRepository: string, version: string, digest: string): Promise<{ alreadyTagged: boolean }> {
  return withRepositoryLock(imageRepository, async () => {
    const current = await headManifest(imageRepository, version);
    if (current) {
      if (current.digest !== digest) {
        throw new PublicationConflictError(`${imageRepository}:${version} points at ${current.digest}, not ${digest}; a listed version is immutable`);
      }
      return { alreadyTagged: true };
    }
    let manifest;
    try {
      manifest = await getManifest(imageRepository, digest);
    } catch (err) {
      if (isNotFound(err)) throw new PublicationNotFoundError(`No manifest ${digest} in ${imageRepository}`);
      throw err;
    }
    await putManifest(imageRepository, version, manifest.raw, manifest.mediaType);
    afterMutation(imageRepository, digest, []);
    return { alreadyTagged: false };
  });
}

/**
 * Delete one public digest the plugin service has cleared for GC (yanked more
 * than 180 days ago, no step manifest references it). This service adds the
 * last guard it CAN check: no tag in the repository still resolves to the
 * digest, directly or as a child of a tagged index. Deletes the manifest and
 * its cosign signature/attestation; the registry's blob GC frees the bytes.
 * Idempotent: an already-deleted digest succeeds with `deleted: false`.
 */
export async function gcPublicImage(imageRepository: string, digest: string): Promise<{ deleted: boolean }> {
  return collectDigest(imageRepository, digest, { ownTag: null }, () =>
    afterMutationOwners(imageRepository, digest));
}

async function afterMutationOwners(imageRepository: string, digest: string): Promise<void> {
  afterMutation(imageRepository, digest, [await publicationOwner(imageRepository).catch(() => null)]);
}

/**
 * Delete one `system/<name>` build copy of a system plugin version the plugin
 * service RETIRED (its row purged, references re-checked). The namespace-
 * specific guard: no tag OTHER than the retired version's own tag (`version`)
 * may still resolve to the digest, directly or as a child of a tagged index —
 * and a protected floating tag (`REGISTRY_GC_PROTECTED_TAGS`) never counts as
 * the version's own, even when it is spelled the same. The version tag itself
 * is removed with the manifest. Idempotent like {@link gcPublicImage}.
 */
export async function gcSystemImage(imageRepository: string, digest: string, version: string): Promise<{ deleted: boolean }> {
  return collectDigest(imageRepository, digest, { ownTag: version }, () => {
    invalidateStorageCache('system/');
    invalidateOrgStorageCache(SYSTEM_ORG_ID);
  });
}

/**
 * The collection both namespaces share: refuse (409) a digest a tag still
 * resolves to — except `ownTag`, when given and not protected, which is
 * deleted first — then delete the manifest and its cosign companions. For a
 * multi-arch index, its child manifests go too, except any a surviving tag
 * still resolves to (directly or as a child of its own index).
 */
async function collectDigest(
  imageRepository: string,
  digest: string,
  opts: { ownTag: string | null },
  onDeleted: () => void | Promise<void>,
): Promise<{ deleted: boolean }> {
  return withRepositoryLock(imageRepository, async () => {
    if (!await headManifest(imageRepository, digest)) return { deleted: false };

    let tags: string[] = [];
    try {
      tags = (await listTags(imageRepository)).tags.filter((t) => !isCosignCompanionTag(t));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const protectedTags = opts.ownTag === null ? null : protectedTagNames();
    let ownTagResolves = false;
    // Every digest a SURVIVING tag still resolves to — directly or as a child of
    // its index. The liveness rule for the collected index's own children: one
    // still in this set is kept, the rest are collected with the index.
    const liveDigests = new Set<string>();
    for (const tag of tags) {
      let m;
      try {
        m = await getManifest(imageRepository, tag);
      } catch (err) {
        if (isNotFound(err)) continue;
        throw err;
      }
      const children = childDigests(m.body);
      if (m.digest !== digest && !children.includes(digest)) {
        liveDigests.add(m.digest);
        for (const c of children) liveDigests.add(c);
        continue;
      }
      if (opts.ownTag !== null && tag === opts.ownTag && !protectedTags!.has(tag.toLowerCase())) {
        ownTagResolves = true;
        continue;
      }
      throw new PublicationConflictError(opts.ownTag === null
        ? `${imageRepository}@${digest} is still referenced by tag ${tag}; yank it first`
        : `${imageRepository}@${digest} is still referenced by tag ${tag}${protectedTags!.has(tag.toLowerCase()) ? ' (a protected floating tag)' : ''}; only its own version tag ${opts.ownTag} may point at a retired image`);
    }

    // Read the collected manifest's own children BEFORE it is deleted: for a
    // multi-arch index, the per-architecture manifests it lists would otherwise
    // be orphaned — untagged, unreachable, and never collected.
    let ownChildren: string[] = [];
    try {
      ownChildren = childDigests((await getManifest(imageRepository, digest)).body);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    if (ownTagResolves) {
      try {
        await deleteTag(imageRepository, opts.ownTag!);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
    await deleteManifest(imageRepository, digest);
    await deleteCompanions(imageRepository, digest);
    for (const child of new Set(ownChildren)) {
      if (child === digest || liveDigests.has(child)) continue;
      try {
        await deleteManifest(imageRepository, child);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      await deleteCompanions(imageRepository, child);
    }
    await onDeleted();
    return { deleted: true };
  });
}

/** The child manifest digests an index lists; none for a single-arch manifest. */
function childDigests(body: unknown): string[] {
  const manifests = (body as { manifests?: Array<{ digest?: string }> } | null)?.manifests ?? [];
  return manifests.map((c) => c.digest).filter((d): d is string => typeof d === 'string');
}

/** Delete a digest's cosign signature / attestation, tolerating ones already gone. */
async function deleteCompanions(imageRepository: string, digest: string): Promise<void> {
  for (const companion of cosignCompanionTags(digest)) {
    const c = await headManifest(imageRepository, companion);
    if (!c) continue;
    try {
      await deleteManifest(imageRepository, c.digest);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

/** @internal Tests only. */
export function _resetPublicPublishingState(): void {
  verifyCache.clear();
  locks.clear();
}
