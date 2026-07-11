// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendError,
  sendEntityNotFound,
  ErrorCode,
  runConcurrent,
  emitAudit,
} from '@pipeline-builder/api-core';
import { withRoute, incCounter } from '@pipeline-builder/api-server';
import { type Router } from 'express';
import { z } from 'zod';
import {
  logger,
  RegistryMetrics,
  COPY_PARALLEL_CHILDREN,
  COPY_PARALLEL_BLOBS,
} from './shared.js';
import {
  getManifest,
  putManifest,
  headManifest,
  mountBlob,
  isNotFound,
} from '../../services/registry-client.js';

// Index media types — anything matching here triggers multi-arch dispatch.
const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

const CopyImageSchema = z.object({
  source: z.string().regex(/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_.-]+$/, 'Invalid source — expected "<repo>:<ref>"'),
  target: z.string().regex(/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_.-]+$/, 'Invalid target — expected "<repo>:<ref>"'),
  overwrite: z.boolean().optional().default(false),
  /** Required when source/target live in different `org-*` tenants. */
  allowCrossTenant: z.boolean().optional().default(false),
});

/**
 * Split a `<repo>:<ref>` string into its components. Repo paths can
 * contain `/` (`org-acme/foo`), so we split on the LAST colon — not naive
 * `split(':')`. The Zod regex guarantees exactly one `:` in the valid
 * input, but this function is robust to that contract.
 */
function parseRepoRef(s: string): { repo: string; ref: string } {
  const i = s.lastIndexOf(':');
  return { repo: s.slice(0, i), ref: s.slice(i + 1) };
}

/**
 * Extract the tenant id from a repo path of the form `org-<id>/...`.
 * Returns null for non-org-prefixed repos (`system/`, `library/`, etc.) —
 * those are platform-managed and have no per-tenant scope.
 */
function tenantOf(repo: string): string | null {
  const match = repo.match(/^org-([a-z0-9][a-z0-9-]*)\//);
  return match ? match[1] : null;
}

/**
 * Register the copy route:
 *  - POST /copy (cross-repo tag-copy; multi-arch aware)
 */
export function registerCopyRoutes(router: Router): void {
  // POST /api/images/copy — cross-repo tag-copy, multi-arch aware.
  router.post('/copy', withRoute(async ({ req, res, ctx }) => {
    const parsed = CopyImageSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return sendBadRequest(res, msg, ErrorCode.VALIDATION_ERROR);
    }
    const { source, target, overwrite, allowCrossTenant } = parsed.data;

    if (source === target) {
      return sendError(
        res, 400,
        'Source and target are identical.',
        ErrorCode.VALIDATION_ERROR,
        { reason: 'source-equals-target' },
      );
    }

    const { repo: sourceRepo, ref: sourceRef } = parseRepoRef(source);
    const { repo: targetRepo, ref: targetRef } = parseRepoRef(target);

    // Cross-tenant guard: copying between two distinct `org-*` namespaces
    // moves data across customer boundaries. Require an explicit opt-in so
    // operators can't do it by accident. Promotions to `system/` or copies
    // within the same org continue to work without the flag.
    const sourceTenant = tenantOf(sourceRepo);
    const targetTenant = tenantOf(targetRepo);
    if (
      sourceTenant !== null &&
      targetTenant !== null &&
      sourceTenant !== targetTenant &&
      !allowCrossTenant
    ) {
      return sendError(
        res, 400,
        'Cross-tenant copy requires "allowCrossTenant: true" in the request body.',
        ErrorCode.VALIDATION_ERROR,
        { reason: 'cross-tenant-not-allowed', sourceTenant, targetTenant },
      );
    }

    // Resolve source manifest.
    let sourceManifest;
    try {
      sourceManifest = await getManifest(sourceRepo, sourceRef);
    } catch (err) {
      if (isNotFound(err)) return sendEntityNotFound(res, 'Source manifest');
      throw err;
    }

    // Overwrite guard.
    if (!overwrite) {
      const existing = await headManifest(targetRepo, targetRef);
      if (existing && existing.digest !== sourceManifest.digest) {
        return sendError(
          res, 409,
          'Target tag already exists with a different digest.',
          ErrorCode.CONFLICT,
          {
            reason: 'target-exists',
            existing: { ref: target, digest: existing.digest },
            requested: { digest: sourceManifest.digest },
          },
        );
      }
    }

    // Copy.
    let mountedBlobs: number;
    let mountedManifests: number;
    try {
      const counts = await copyManifestTree(sourceManifest, sourceRepo, targetRepo, targetRef);
      mountedBlobs = counts.blobs;
      mountedManifests = counts.manifests;
    } catch (err) {
      if (err instanceof SourceIncompleteError) {
        return sendError(
          res, 409,
          err.message,
          ErrorCode.CONFLICT,
          { reason: 'source-incomplete', missingDigest: err.missingDigest },
        );
      }
      if (err instanceof InvalidManifestError) {
        return sendError(
          res, 400,
          err.message,
          ErrorCode.VALIDATION_ERROR,
          { reason: 'invalid-manifest' },
        );
      }
      throw err;
    }

    ctx.log('COMPLETED', 'Copied manifest', {
      source,
      target,
      sourceDigest: sourceManifest.digest,
      mountedManifests,
      mountedBlobs,
    });

    emitAudit(logger, {
      event: 'registry.tag.copy',
      actor: req.user?.sub ?? 'unknown',
      source,
      target,
      sourceDigest: sourceManifest.digest,
      targetDigest: sourceManifest.digest,
      isPromotionToSystem: targetRepo.startsWith('system/'),
      mounted: { manifests: mountedManifests, blobs: mountedBlobs },
    });
    // Two counters: total copies + a separate counter for system-promotions
    // so the dashboard can show promotion velocity without dividing series.
    incCounter(RegistryMetrics.TAG_COPY);
    if (targetRepo.startsWith('system/')) {
      incCounter(RegistryMetrics.TAG_PROMOTE);
    }

    return sendSuccess(res, 200, {
      source,
      target,
      digest: sourceManifest.digest,
      mounted: { manifests: mountedManifests, blobs: mountedBlobs },
    });
  }));
}

/**
 * Thrown when a layer or child manifest referenced by the source manifest
 * has gone missing mid-copy. Surfaced to the caller as 409 source-incomplete.
 */
class SourceIncompleteError extends Error {
  constructor(public missingDigest: string) {
    super(`Source manifest references digest ${missingDigest} which is no longer in the source repo.`);
    this.name = 'SourceIncompleteError';
  }
}

/**
 * Thrown when a manifest is missing the `config.digest` required by the
 * OCI v1 image spec. Pre-OCI / legacy formats sometimes omit it; this
 * registry no longer accepts them. Surface as 400 to the caller — the
 * push tooling needs to be upgraded to emit OCI-compliant manifests.
 */
class InvalidManifestError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidManifestError';
  }
}

/**
 * Copy a manifest (single-arch or multi-arch index) from source to target.
 * Mounts every unique blob digest referenced by the manifest tree, then
 * PUTs the manifest(s) under the target ref. Idempotent: re-running with
 * the same args is a no-op.
 *
 * Assumption: every child manifest referenced by a multi-arch index lives
 * in the same `sourceRepo`. Cross-repo manifest references (which the OCI
 * spec permits in principle, but our push pipeline never emits) would
 * throw `SourceIncompleteError` when the child digest isn't resolvable
 * inside `sourceRepo`.
 */
async function copyManifestTree(
  sourceManifest: { body: unknown; digest: string; mediaType: string },
  sourceRepo: string,
  targetRepo: string,
  targetRef: string,
): Promise<{ manifests: number; blobs: number }> {
  const body = sourceManifest.body as Record<string, unknown>;
  const isIndex = INDEX_MEDIA_TYPES.has(sourceManifest.mediaType);

  if (isIndex) {
    const children = (body.manifests as Array<{ digest: string }> | undefined) ?? [];
    // Collect unique blob digests across all child manifests so duplicates
    // (shared base layers across platforms) get mounted once.
    const uniqueBlobs = new Set<string>();
    const childManifestBodies: Array<{ digest: string; body: unknown; mediaType: string }> = [];

    await runConcurrent(children, COPY_PARALLEL_CHILDREN, async (child) => {
      let m;
      try {
        m = await getManifest(sourceRepo, child.digest);
      } catch (err) {
        if (isNotFound(err)) throw new SourceIncompleteError(child.digest);
        throw err;
      }
      const cbody = m.body as Record<string, unknown>;
      const configDigest = (cbody.config as { digest?: string } | undefined)?.digest;
      const layerDigests = ((cbody.layers as Array<{ digest: string }> | undefined) ?? []).map((l) => l.digest);
      if (!configDigest) {
        throw new InvalidManifestError(`Child manifest ${child.digest} is missing config.digest (OCI v1 requires it).`);
      }
      uniqueBlobs.add(configDigest);
      for (const d of layerDigests) uniqueBlobs.add(d);
      childManifestBodies.push({ digest: child.digest, body: m.body, mediaType: m.mediaType });
    });

    // Mount unique blobs in parallel.
    await runConcurrent([...uniqueBlobs], COPY_PARALLEL_BLOBS, async (digest) => {
      try {
        await mountBlob(sourceRepo, targetRepo, digest);
      } catch (err) {
        if (isNotFound(err)) throw new SourceIncompleteError(digest);
        throw err;
      }
    });

    // PUT each child manifest under its digest (no tag — addressable by digest from the index).
    for (const child of childManifestBodies) {
      await putManifest(targetRepo, child.digest, child.body, child.mediaType);
    }

    // PUT the index manifest at the target ref.
    await putManifest(targetRepo, targetRef, sourceManifest.body, sourceManifest.mediaType);

    return { manifests: 1 + childManifestBodies.length, blobs: uniqueBlobs.size };
  }

  // Single-arch.
  const configDigest = ((body.config as { digest?: string } | undefined)?.digest);
  const layerDigests = ((body.layers as Array<{ digest: string }> | undefined) ?? []).map((l) => l.digest);
  // OCI v1 requires config.digest on every single-arch manifest. Reject
  // manifests that omit it — accepting them silently was the legacy path
  // that let pre-OCI tooling smuggle untracked content into the registry.
  if (!configDigest) {
    throw new InvalidManifestError(`Source manifest ${sourceManifest.digest ?? '<unknown>'} is missing config.digest (OCI v1 requires it).`);
  }
  const digests = [configDigest, ...layerDigests];

  await runConcurrent(digests, COPY_PARALLEL_BLOBS, async (digest) => {
    try {
      await mountBlob(sourceRepo, targetRepo, digest);
    } catch (err) {
      if (isNotFound(err)) throw new SourceIncompleteError(digest);
      throw err;
    }
  });

  await putManifest(targetRepo, targetRef, sourceManifest.body, sourceManifest.mediaType);

  return { manifests: 1, blobs: digests.length };
}
