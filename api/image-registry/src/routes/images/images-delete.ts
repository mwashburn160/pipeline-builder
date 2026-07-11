// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendEntityNotFound,
  ErrorCode,
  getParam,
  runConcurrent,
  emitAudit,
} from '@pipeline-builder/api-core';
import { withRoute, incCounter } from '@pipeline-builder/api-server';
import { type Router } from 'express';
import { logger, RegistryMetrics, COPY_PARALLEL_BLOBS } from './shared.js';
import {
  listTags,
  getManifest,
  deleteManifest,
  isNotFound,
} from '../../services/registry-client.js';

/**
 * Register the destructive routes:
 *  - DELETE /:name/manifests/:reference (delete one manifest by ref)
 *  - DELETE /:name                      (prune a whole repo — deletes all tags)
 *
 * Registration order matters: `/:name/manifests/:reference` must be
 * registered before the `/:name` catch-all so the two never collide.
 */
export function registerDeleteRoutes(router: Router): void {
  // DELETE /api/images/:name/manifests/:reference — resolve to digest, then delete.
  router.delete('/:name/manifests/:reference', withRoute(async ({ req, res, ctx }) => {
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
  router.delete('/:name', withRoute(async ({ req, res, ctx }) => {
    const name = getParam(req.params, 'name');
    if (!name) return sendBadRequest(res, 'Image name is required', ErrorCode.MISSING_REQUIRED_FIELD);

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

    let deletedManifests = 0;
    await runConcurrent([...digests], COPY_PARALLEL_BLOBS, async (digest) => {
      try {
        await deleteManifest(name, digest);
        deletedManifests++; // safe: no `await` between read and write (single-threaded)
      } catch (err) {
        if (isNotFound(err)) return; // already gone — idempotent
        throw err;
      }
    });

    ctx.log('COMPLETED', 'Pruned repository', { name, deletedManifests, tags: tags.length });
    emitAudit(logger, {
      event: 'registry.repo.delete',
      actor: req.user?.sub ?? 'unknown',
      repo: name,
      deletedManifests,
      deletedTags: tags.length,
    });
    incCounter(RegistryMetrics.REPO_DELETE);

    return sendSuccess(res, 200, { name, deletedManifests, deletedTags: tags.length });
  }));
}
