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
 * Every mutation of one repository is serialized in-process, so a concurrent
 * publish + yank (or two re-signs) can't interleave a signature drop with a
 * sign. The plugin service drives these one image at a time.
 */

import { envInt, createLogger, AppError, ErrorCode } from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '@pipeline-builder/api-server';

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

export const TRUST_TIERS = ['official', 'verified', 'community', 'unverified'] as const;
export type TrustTier = typeof TRUST_TIERS[number];

/** Metric names. */
export const PublicationMetrics = {
  PUBLISH: 'registry_public_publish_total',
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

async function withRepositoryLock<T>(repository: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(repository) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
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
  tier: TrustTier | null;
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

function isTrustTier(v: unknown): v is TrustTier {
  return typeof v === 'string' && (TRUST_TIERS as readonly string[]).includes(v);
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
    result = tiers.size === 1 && publishers.size === 1 && isTrustTier(tier) && typeof publisher === 'string' && publisher
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

function annotationsFor(tier: TrustTier, publisherHandle: string): Record<string, string> {
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
  tier: TrustTier;
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
  return withRepositoryLock(target, async () => {
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

    let sbom: Record<string, unknown>;
    try {
      sbom = await readSignedSbom(p.sourceRepository, p.digest);
    } catch (err) {
      if (err instanceof CosignRejectedError) {
        throw new SourceVerificationError(`${p.sourceRepository}@${p.digest} has no SBOM attestation signed by the platform; rebuild it before publishing`);
      }
      throw err;
    }

    await copyManifestTree(source, p.sourceRepository, target, p.digest);
    await writePublicationRecord(target, p.publisherOrgId);
    await signPluginImage({ repository: target, digest: p.digest, sbom, annotations: annotationsFor(p.tier, p.publisherHandle) });
    if (!existing) await putManifest(target, p.version, source.raw, source.mediaType);

    afterMutation(target, p.digest, [p.publisherOrgId]);
    logger.info('Published plugin image', { target, digest: p.digest, version: p.version, tier: p.tier, alreadyPublished: !!existing });
    return { imageRepository: target, digest: p.digest, alreadyPublished: !!existing };
  });
}

export interface ResignParams {
  imageRepository: string;
  digest: string;
  publisherHandle: string;
  tier: TrustTier;
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
  return withRepositoryLock(imageRepository, async () => {
    if (!await headManifest(imageRepository, digest)) return { deleted: false };

    let tags: string[] = [];
    try {
      tags = (await listTags(imageRepository)).tags.filter((t) => !isCosignCompanionTag(t));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    for (const tag of tags) {
      let m;
      try {
        m = await getManifest(imageRepository, tag);
      } catch (err) {
        if (isNotFound(err)) continue;
        throw err;
      }
      const children = ((m.body as { manifests?: Array<{ digest?: string }> }).manifests ?? []).map((c) => c.digest);
      if (m.digest === digest || children.includes(digest)) {
        throw new PublicationConflictError(`${imageRepository}@${digest} is still referenced by tag ${tag}; yank it first`);
      }
    }

    await deleteManifest(imageRepository, digest);
    for (const companion of cosignCompanionTags(digest)) {
      const c = await headManifest(imageRepository, companion);
      if (!c) continue;
      try {
        await deleteManifest(imageRepository, c.digest);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
    afterMutation(imageRepository, digest, [await publicationOwner(imageRepository).catch(() => null)]);
    return { deleted: true };
  });
}

/** @internal Tests only. */
export function _resetPublicPublishingState(): void {
  verifyCache.clear();
  locks.clear();
}
