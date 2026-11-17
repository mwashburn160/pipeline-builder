// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendEntityNotFound,
  sendError,
  errorMessage,
  ErrorCode,
  getParam,
  runConcurrent,
  logAuditEvent,
  audited,
  requirePermission,
  requireAssurance,
} from '@pipeline-builder/api-core';
import { withRoute, incCounter } from '@pipeline-builder/api-server';
import { type Request, type Response, type Router, type RequestHandler } from 'express';
import { canWriteRepo } from './repo-access.js';
import { denyRepoNotOwned, logger, recordRegistryAudit, RegistryMetrics } from './shared.js';
import { deleteCosignCompanions } from '../../services/cosign-tags.js';
import { COPY_PARALLEL_BLOBS } from '../../services/manifest-copy.js';
import { repoOwnerOrgId } from '../../services/namespaces.js';
import { pipelinesReferencingImages, type ImagePipelineReference } from '../../services/plugin-image-references.js';
import {
  listTags,
  getManifest,
  deleteManifest,
  isNotFound,
} from '../../services/registry-client.js';
import { invalidateOrgStorageCache, invalidateStorageCache } from '../../services/storage-usage.js';

/**
 * Refuse deleting any of `digests` while a pipeline references it — 409
 * PLUGIN_VERSION_IN_USE naming the pipelines, with NO override (no force flag,
 * no operator exception): the pipeline's next pull would fail, and a vulnerable
 * image is the worst one to take away. Update the pipelines first. The answer
 * comes from the plugin service (the one `findVersionReferences` rule every
 * removal path asks); when it cannot be read nothing is deleted (503).
 * Returns true when it answered (refused), false when the delete may proceed.
 */
async function refuseIfInUse(
  req: Request, res: Response, userId: string, name: string, digests: Iterable<string>,
): Promise<boolean> {
  let references;
  try {
    references = await pipelinesReferencingImages(digests);
  } catch (err) {
    logger.warn('Image delete refused: pipeline references unreadable', { name, error: errorMessage(err) });
    sendError(res, 503, 'Could not confirm that no pipeline references this image, so nothing was deleted. Try again shortly.', ErrorCode.SERVICE_UNAVAILABLE);
    return true;
  }
  if (references.length === 0) return false;

  const pipelines = new Map<string, ImagePipelineReference['pipelines'][number]>();
  for (const r of references) for (const p of r.pipelines) pipelines.set(p.id, p);
  const pipelineCount = Math.max(pipelines.size, ...references.map((r) => r.pipelineCount));
  const named = [...pipelines.values()].slice(0, 10).map((p) => p.name ?? p.id).join(', ');
  recordRegistryAudit(req, userId, {
    action: 'registry.image.delete',
    ownerOrgId: repoOwnerOrgId(name),
    targetId: name,
    outcome: 'failure',
    details: { repo: name, refusal: ErrorCode.PLUGIN_VERSION_IN_USE, digests: references.map((r) => r.digest), pipelineCount },
  });
  sendError(res, 409,
    `${name} is in use by ${pipelineCount} pipeline${pipelineCount === 1 ? '' : 's'} (${named}${pipelines.size > 10 ? ', …' : ''}). `
    + 'An image a pipeline references cannot be deleted — update those pipelines to another image first.',
    ErrorCode.PLUGIN_VERSION_IN_USE,
    { reason: 'in_use', pipelineCount, references, pipelines: [...pipelines.values()] });
  return true;
}

/** The storage figures a delete in `name` made stale: its namespace rollup and the owner's rollup + breakdown. */
function invalidateStorageAfterDelete(name: string): void {
  const slash = name.indexOf('/');
  if (slash > 0) invalidateStorageCache(name.slice(0, slash + 1));
  const owner = repoOwnerOrgId(name);
  if (owner) invalidateOrgStorageCache(owner);
}

/**
 * Register the destructive routes (each gated on `registry:purge`):
 *  - DELETE /:name/manifests/:reference (delete one manifest by ref)
 *  - DELETE /:name (prune a whole repo — deletes all tags)
 *
 * Registration order matters: `/:name/manifests/:reference` must be
 * registered before the `/:name` catch-all so the two never collide.
 *
 * `registry:purge`, not `registry:write`: these two and the GC prune are the
 * registry actions with no undo, and they keep the narrower permission (see
 * `SUPERADMIN_ONLY_PERMISSIONS`). Each also demands an MFA-grade session, for
 * the same reason the consoles do — a stolen password is not enough to delete
 * the image a tenant's running pipeline resolves. `requireAssurance` refuses a
 * machine principal outright, which is correct here: no service deletes through
 * this surface (the plugin service has its own internal yank/gc routes under
 * `/internal`, on the management identity).
 *
 * Neither deletes an image any pipeline still references ({@link refuseIfInUse}):
 * a 409 naming the pipelines, whoever asks, with no force flag.
 */
export function registerDeleteRoutes(router: Router): void {
  const purge: RequestHandler[] = [
    requirePermission('registry:purge') as RequestHandler,
    requireAssurance({ minAssurance: 2 }) as RequestHandler,
  ];

  // DELETE /api/images/:name/manifests/:reference — resolve to digest, then delete.
  router.delete('/:name/manifests/:reference', ...purge, audited('registry.image.delete'), withRoute(async ({ req, res, ctx, userId }) => {
    const name = getParam(req.params, 'name');
    const reference = getParam(req.params, 'reference');
    if (!name || !reference) return sendBadRequest(res, 'name and reference are required', ErrorCode.MISSING_REQUIRED_FIELD);
    if (!canWriteRepo(req.user, name)) return denyRepoNotOwned(req, res, name, 'write');

    try {
      // Distribution requires DELETE by digest, not tag. Resolve first.
      const { digest } = await getManifest(name, reference);
      if (await refuseIfInUse(req, res, userId, name, [digest])) return;
      await deleteManifest(name, digest);
      const deletedCompanions = await deleteCosignCompanions(name, digest);
      invalidateStorageAfterDelete(name);
      ctx.log('COMPLETED', 'Deleted manifest', { name, reference, digest, deletedCompanions });
      // The operator-facing Loki line; `recordRegistryAudit` below is its durable
      // twin — see that helper for why both exist.
      logAuditEvent(logger, {
        event: 'registry.tag.delete',
        actor: req.user?.sub ?? 'unknown',
        repo: name,
        ref: reference,
        digest,
      });
      recordRegistryAudit(req, userId, {
        action: 'registry.image.delete',
        ownerOrgId: repoOwnerOrgId(name),
        targetId: name,
        details: { scope: 'tag', repo: name, ref: reference, digest },
      });
      incCounter(RegistryMetrics.TAG_DELETE);
      return sendSuccess(res, 200, { name, digest, deleted: true });
    } catch (err) {
      if (isNotFound(err)) return sendEntityNotFound(res, 'Manifest');
      throw err;
    }
  }));

  // DELETE /api/images/:name — prune an entire repository by deleting ALL its
  // tags. The registry's v2/v3 HTTP API can only delete manifests, not remove
  // the repo directory, so the repo goes to 0 tags but its now-hollow entry
  // lingers in `/v2/_catalog` until on-disk GC/rm removes the dir. Pair with
  // `GET /api/images?nonEmpty=true` so the UI stops showing the emptied repo.
  // (Registered after the `/:name/manifests/:reference` route; `:name` only
  // matches a single URL segment, so the two never collide.)
  router.delete('/:name', ...purge, audited('registry.image.delete'), withRoute(async ({ req, res, ctx, userId }) => {
    const name = getParam(req.params, 'name');
    if (!name) return sendBadRequest(res, 'Image name is required', ErrorCode.MISSING_REQUIRED_FIELD);
    if (!canWriteRepo(req.user, name)) return denyRepoNotOwned(req, res, name, 'write');

    let tags: string[];
    try {
      const result = await listTags(name);
      tags = result.tags ?? [];
    } catch (err) {
      if (isNotFound(err)) return sendEntityNotFound(res, 'Image');
      throw err;
    }

    if (tags.length === 0) {
      ctx.log('COMPLETED', 'Repository already empty', { name });
      return sendSuccess(res, 200, { name, deletedManifests: 0, deletedTags: 0, alreadyEmpty: true });
    }

    // Resolve every tag to its manifest digest, deduped: multiple tags can point
    // at the same digest, and deleting a digest removes all tags referencing it.
    const digests = new Set<string>();
    await runConcurrent(tags, COPY_PARALLEL_BLOBS, async (tag) => {
      try {
        const { digest } = await getManifest(name, tag);
        digests.add(digest);
      } catch (err) {
        if (isNotFound(err)) return; // tag raced away between list and resolve
        throw err;
      }
    });

    // Nothing is deleted while ANY of the repo's images is still referenced.
    if (await refuseIfInUse(req, res, userId, name, digests)) return;

    let deletedManifests = 0;
    const deletedDigests: string[] = [];
    try {
      await runConcurrent([...digests], COPY_PARALLEL_BLOBS, async (digest) => {
        try {
          await deleteManifest(name, digest);
          deletedManifests++; // safe: no `await` between read and write (single-threaded)
          deletedDigests.push(digest);
        } catch (err) {
          if (isNotFound(err)) return; // already gone — idempotent
          throw err;
        }
      });
    } catch (err) {
      // Died part-way: some manifests are already gone and there is no undo, so
      // the prune goes on the trail as a failure naming exactly what was lost.
      if (deletedManifests > 0) {
        recordRegistryAudit(req, userId, {
          action: 'registry.image.delete',
          ownerOrgId: repoOwnerOrgId(name),
          targetId: name,
          outcome: 'failure',
          details: { scope: 'repo', repo: name, deletedManifests, deletedDigests, requestedManifests: digests.size, deletedTags: null, partial: true },
        });
      }
      throw err;
    } finally {
      if (deletedManifests > 0) invalidateStorageAfterDelete(name);
    }

    ctx.log('COMPLETED', 'Pruned repository', { name, deletedManifests, tags: tags.length });
    // The operator-facing Loki line; `recordRegistryAudit` below is its durable
    // twin — see that helper for why both exist.
    logAuditEvent(logger, {
      event: 'registry.repo.delete',
      actor: req.user?.sub ?? 'unknown',
      repo: name,
      deletedManifests,
      deletedTags: tags.length,
    });
    recordRegistryAudit(req, userId, {
      action: 'registry.image.delete',
      ownerOrgId: repoOwnerOrgId(name),
      targetId: name,
      details: { scope: 'repo', repo: name, deletedManifests, deletedTags: tags.length, deletedDigests },
    });
    incCounter(RegistryMetrics.REPO_DELETE);

    return sendSuccess(res, 200, { name, deletedManifests, deletedTags: tags.length });
  }));
}
