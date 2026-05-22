// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendError,
  sendEntityNotFound,
  ErrorCode,
  getParam,
  isSystemAdmin,
  parsePaginationParams,
  runConcurrent,
  emitAudit,
  createLogger,
} from '@pipeline-builder/api-core';
import { withRoute, incCounter } from '@pipeline-builder/api-server';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  listRepositories,
  listTags,
  getManifest,
  deleteManifest,
  putManifest,
  headManifest,
  headBlob,
  getBlobStream,
  mountBlob,
  isNotFound,
} from '../services/registry-client';

const logger = createLogger('image-routes');

// 5 MB cap for the blob proxy. The endpoint is for previewing config blobs
// in the registry UI's manifest summary — config blobs are always small
// (typically < 50 KB). Larger payloads (layer blobs, attestations) are
// rejected with 413 so the platform can't OOM serving a multi-GB layer.
// Override via `REGISTRY_MAX_BLOB_PROXY_BYTES`.
const MAX_BLOB_PROXY_BYTES = parseInt(process.env.REGISTRY_MAX_BLOB_PROXY_BYTES || String(5 * 1024 * 1024), 10);

// Parallelism budget for cross-repo copy. 3 children × 8 unique blobs per
// child = 24 in-flight registry calls at most. Tuned for a comfortable load
// on the in-cluster registry. Override via `REGISTRY_COPY_PARALLEL_*`.
const COPY_PARALLEL_CHILDREN = parseInt(process.env.REGISTRY_COPY_PARALLEL_CHILDREN || '3', 10);
const COPY_PARALLEL_BLOBS = parseInt(process.env.REGISTRY_COPY_PARALLEL_BLOBS || '8', 10);

// Index media types — anything matching here triggers multi-arch dispatch.
const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

const CopyImageSchema = z.object({
  source: z.string().regex(/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_.-]+$/, 'Invalid source — expected "<repo>:<ref>"'),
  target: z.string().regex(/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_.-]+$/, 'Invalid target — expected "<repo>:<ref>"'),
  overwrite: z.boolean().optional().default(false),
});

/** Sysadmin guard. */
function requireSystemAdminGuard(req: Request, res: Response): boolean {
  if (!isSystemAdmin(req)) {
    sendError(res, 403, 'System admin access required', ErrorCode.INSUFFICIENT_PERMISSIONS);
    return false;
  }
  return true;
}

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
 * Image management endpoints. All system-admin only — these proxy to the
 * underlying registry v2 ops using `pipeline-image-registry`'s own
 * service-account credentials. Customers never reach the underlying
 * registry directly through these routes.
 *
 * Routes:
 *  - GET    /api/images
 *  - GET    /api/images/:name/tags
 *  - GET    /api/images/:name/manifests/:reference
 *  - DELETE /api/images/:name/manifests/:reference
 *  - GET    /api/images/:name/blobs/:digest        (5MB cap; config blobs only)
 *  - POST   /api/images/copy                       (cross-repo; multi-arch aware)
 */
export function createImageRoutes(): Router {
  const router = Router();

  // GET /api/images — list all repositories (cursor-paginated via _catalog).
  router.get('/', withRoute(async ({ req, res, ctx }) => {
    if (!requireSystemAdminGuard(req, res)) return;
    const { limit } = parsePaginationParams(req.query as Record<string, unknown>);
    const last = typeof req.query.last === 'string' ? req.query.last : undefined;

    const result = await listRepositories({ n: limit, last });
    ctx.log('COMPLETED', 'Listed repositories', { count: result.repositories.length });

    return sendSuccess(res, 200, {
      repositories: result.repositories,
      ...(result.next && { next: result.next }),
    });
  }));

  // GET /api/images/:name/tags — list tags for one repository.
  router.get('/:name/tags', withRoute(async ({ req, res, ctx }) => {
    if (!requireSystemAdminGuard(req, res)) return;
    const name = getParam(req.params, 'name');
    if (!name) return sendBadRequest(res, 'Image name is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const result = await listTags(name);
    ctx.log('COMPLETED', 'Listed tags', { name, count: result.tags.length });
    return sendSuccess(res, 200, result);
  }));

  // GET /api/images/:name/manifests/:reference — fetch manifest.
  router.get('/:name/manifests/:reference', withRoute(async ({ req, res, ctx }) => {
    if (!requireSystemAdminGuard(req, res)) return;
    const name = getParam(req.params, 'name');
    const reference = getParam(req.params, 'reference');
    if (!name || !reference) return sendBadRequest(res, 'name and reference are required', ErrorCode.MISSING_REQUIRED_FIELD);

    try {
      const result = await getManifest(name, reference);
      ctx.log('COMPLETED', 'Fetched manifest', { name, reference, digest: result.digest });
      return sendSuccess(res, 200, result);
    } catch (err) {
      if (isNotFound(err)) return sendEntityNotFound(res, 'Manifest');
      throw err;
    }
  }));

  // DELETE /api/images/:name/manifests/:reference — resolve to digest, then delete.
  router.delete('/:name/manifests/:reference', withRoute(async ({ req, res, ctx }) => {
    if (!requireSystemAdminGuard(req, res)) return;
    const name = getParam(req.params, 'name');
    const reference = getParam(req.params, 'reference');
    if (!name || !reference) return sendBadRequest(res, 'name and reference are required', ErrorCode.MISSING_REQUIRED_FIELD);

    try {
      // Distribution requires DELETE by digest, not tag. Resolve first.
      const { digest } = await getManifest(name, reference);
      await deleteManifest(name, digest);
      ctx.log('COMPLETED', 'Deleted manifest', { name, reference, digest });
      emitAudit(logger, {
        event: 'registry.tag.delete',
        actor: req.user?.sub ?? 'unknown',
        repo: name,
        ref: reference,
        digest,
      });
      incCounter('registry_tag_delete_total');
      return sendSuccess(res, 200, { name, digest, deleted: true });
    } catch (err) {
      if (isNotFound(err)) return sendEntityNotFound(res, 'Manifest');
      throw err;
    }
  }));

  // GET /api/images/:name/blobs/:digest — proxy a config blob (5MB cap, streamed).
  router.get('/:name/blobs/:digest', withRoute(async ({ req, res, ctx }) => {
    if (!requireSystemAdminGuard(req, res)) return;
    const name = getParam(req.params, 'name');
    const digest = getParam(req.params, 'digest');
    if (!name || !digest) return sendBadRequest(res, 'name and digest are required', ErrorCode.MISSING_REQUIRED_FIELD);

    // Fast path: HEAD first to reject oversize before opening the stream.
    try {
      const head = await headBlob(name, digest);
      if (head.contentLength !== undefined && head.contentLength > MAX_BLOB_PROXY_BYTES) {
        return sendError(
          res, 413,
          'Blob exceeds 5MB cap. This endpoint serves config blobs only; layer blobs are not previewable.',
          ErrorCode.PAYLOAD_TOO_LARGE,
        );
      }
    } catch (err) {
      if (isNotFound(err)) return sendEntityNotFound(res, 'Blob');
      throw err;
    }

    // Stream the body. If the registry omitted Content-Length on HEAD,
    // byte-count the stream and abort on overrun.
    let stream;
    try {
      const got = await getBlobStream(name, digest);
      stream = got.stream;
      res.setHeader('Content-Type', got.contentType);
      if (got.contentLength !== undefined) {
        res.setHeader('Content-Length', String(got.contentLength));
      }
    } catch (err) {
      if (isNotFound(err)) return sendEntityNotFound(res, 'Blob');
      throw err;
    }

    let bytes = 0;
    let aborted = false;
    const abort = (statusCode: number, message: string) => {
      if (aborted) return;
      aborted = true;
      stream.destroy();
      if (!res.headersSent) {
        sendError(res, statusCode, message, ErrorCode.PAYLOAD_TOO_LARGE);
      } else {
        res.end();
      }
    };

    // Release the upstream connection if the client navigates away.
    req.on('close', () => { if (!res.writableEnded) stream.destroy(); });

    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BLOB_PROXY_BYTES) {
        abort(413, 'Blob exceeds 5MB cap. This endpoint serves config blobs only; layer blobs are not previewable.');
      }
    });
    stream.on('error', (err: Error) => {
      if (aborted) return;
      aborted = true;
      ctx.log('ERROR', 'Blob stream error', { name, digest, error: err.message });
      if (!res.headersSent) sendError(res, 502, 'Upstream registry error', ErrorCode.INTERNAL_ERROR);
      else res.end();
    });
    stream.on('end', () => {
      if (!aborted) {
        ctx.log('COMPLETED', 'Streamed blob', { name, digest, bytes });
      }
    });
    stream.pipe(res);
  }));

  // POST /api/images/copy — cross-repo tag-copy, multi-arch aware.
  router.post('/copy', withRoute(async ({ req, res, ctx }) => {
    if (!requireSystemAdminGuard(req, res)) return;

    const parsed = CopyImageSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return sendBadRequest(res, msg, ErrorCode.VALIDATION_ERROR);
    }
    const { source, target, overwrite } = parsed.data;

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
      source, target,
      sourceDigest: sourceManifest.digest,
      mountedManifests, mountedBlobs,
    });

    emitAudit(logger, {
      event: 'registry.tag.copy',
      actor: req.user?.sub ?? 'unknown',
      source, target,
      sourceDigest: sourceManifest.digest,
      targetDigest: sourceManifest.digest,
      isPromotionToSystem: targetRepo.startsWith('system/'),
      mounted: { manifests: mountedManifests, blobs: mountedBlobs },
    });
    // Two counters: total copies + a separate counter for system-promotions
    // so the dashboard can show promotion velocity without dividing series.
    incCounter('registry_tag_copy_total');
    if (targetRepo.startsWith('system/')) {
      incCounter('registry_tag_promote_total');
    }

    return sendSuccess(res, 200, {
      source, target,
      digest: sourceManifest.digest,
      mounted: { manifests: mountedManifests, blobs: mountedBlobs },
    });
  }));

  return router;
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
