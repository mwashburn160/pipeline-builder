// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendEntityNotFound,
  ErrorCode,
  getParam,
  parsePaginationParams,
  runConcurrent,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { type Router } from 'express';
import { COPY_PARALLEL_BLOBS } from './shared.js';
import {
  listRepositories,
  listTags,
  getManifest,
  isNotFound,
} from '../../services/registry-client.js';

/**
 * Register the read-only listing/fetch routes:
 *  - GET /                              (list repositories)
 *  - GET /:name/tags                    (list tags)
 *  - GET /:name/manifests/:reference    (fetch manifest)
 */
export function registerListRoutes(router: Router): void {
  // GET /api/images — list all repositories (cursor-paginated via _catalog).
  //
  // `?nonEmpty=true` filters out repos with zero tags. The registry keeps a
  // repo's directory in `/v2/_catalog` even after ALL its tags are deleted
  // (v2/v3 don't remove empty repo dirs over HTTP), so pruned/empty repos keep
  // showing as hollow shells. This flag hides them. It costs one `tags/list`
  // call per repo on the page (bounded concurrency), so it's opt-in — the UI
  // requests it; the default listing stays a single `_catalog` call.
  router.get('/', withRoute(async ({ req, res, ctx }) => {
    const { limit } = parsePaginationParams(req.query as Record<string, unknown>);
    const last = typeof req.query.last === 'string' ? req.query.last : undefined;
    const nonEmpty = req.query.nonEmpty === 'true' || req.query.nonEmpty === '1';

    const result = await listRepositories({ n: limit, last });
    let repositories = result.repositories;

    if (nonEmpty && repositories.length > 0) {
      const withTags = new Set<string>();
      await runConcurrent(repositories, COPY_PARALLEL_BLOBS, async (repo) => {
        try {
          const { tags } = await listTags(repo);
          if ((tags?.length ?? 0) > 0) withTags.add(repo);
        } catch (err) {
          // A repo that 404s on tags/list mid-list is treated as empty (skip).
          if (!isNotFound(err)) throw err;
        }
      });
      repositories = repositories.filter((r) => withTags.has(r)); // preserve order
    }

    ctx.log('COMPLETED', 'Listed repositories', { count: repositories.length, nonEmpty });

    return sendSuccess(res, 200, {
      repositories,
      ...(result.next && { next: result.next }),
    });
  }));

  // GET /api/images/:name/tags — list tags for one repository.
  router.get('/:name/tags', withRoute(async ({ req, res, ctx }) => {
    const name = getParam(req.params, 'name');
    if (!name) return sendBadRequest(res, 'Image name is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const result = await listTags(name);
    ctx.log('COMPLETED', 'Listed tags', { name, count: result.tags.length });
    return sendSuccess(res, 200, result);
  }));

  // GET /api/images/:name/manifests/:reference — fetch manifest.
  router.get('/:name/manifests/:reference', withRoute(async ({ req, res, ctx }) => {
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
}
