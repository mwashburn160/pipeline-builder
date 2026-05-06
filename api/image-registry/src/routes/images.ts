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
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import {
  listRepositories,
  listTags,
  getManifest,
  deleteManifest,
  putManifest,
} from '../services/registry-client';

const TagCopySchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
});

/** Sysadmin guard. */
function requireSystemAdminGuard(req: Parameters<typeof isSystemAdmin>[0], res: Parameters<typeof sendError>[0]): boolean {
  if (!isSystemAdmin(req)) {
    sendError(res, 403, 'System admin access required', ErrorCode.INSUFFICIENT_PERMISSIONS);
    return false;
  }
  return true;
}

/**
 * Image management endpoints. All system-admin only — these proxy to
 * underlying registry v2 ops using `pipeline-image-registry`'s own
 * service-account credentials. Customers never reach the underlying
 * registry directly through these.
 */
export function createImageRoutes(): Router {
  const router = Router();

  // GET /api/images — list all repositories (paginated via underlying _catalog)
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

  // GET /api/images/:name/tags — list tags for one repository
  router.get('/:name/tags', withRoute(async ({ req, res, ctx }) => {
    if (!requireSystemAdminGuard(req, res)) return;
    const name = getParam(req.params, 'name');
    if (!name) return sendBadRequest(res, 'Image name is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const result = await listTags(name);
    ctx.log('COMPLETED', 'Listed tags', { name, count: result.tags.length });
    return sendSuccess(res, 200, result);
  }));

  // GET /api/images/:name/manifests/:reference — fetch manifest
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
      if (isAxiosNotFound(err)) return sendEntityNotFound(res, 'Manifest');
      throw err;
    }
  }));

  // DELETE /api/images/:name/manifests/:reference — resolve to digest, then delete
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
      return sendSuccess(res, 200, { name, digest, deleted: true });
    } catch (err) {
      if (isAxiosNotFound(err)) return sendEntityNotFound(res, 'Manifest');
      throw err;
    }
  }));

  // POST /api/images/:name/tags — tag-copy: fetch source manifest, PUT under target
  router.post('/:name/tags', withRoute(async ({ req, res, ctx }) => {
    if (!requireSystemAdminGuard(req, res)) return;
    const name = getParam(req.params, 'name');
    if (!name) return sendBadRequest(res, 'name is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const parsed = TagCopySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return sendBadRequest(res, msg, ErrorCode.VALIDATION_ERROR);
    }
    const { source, target } = parsed.data;

    try {
      const fetched = await getManifest(name, source);
      const { digest } = await putManifest(name, target, fetched.body, fetched.mediaType);
      ctx.log('COMPLETED', 'Tag-copied manifest', { name, source, target, digest });
      return sendSuccess(res, 201, { name, source, target, digest });
    } catch (err) {
      if (isAxiosNotFound(err)) return sendEntityNotFound(res, 'Source manifest');
      throw err;
    }
  }));

  return router;
}

/** Best-effort detection of axios 404. Avoids importing axios's type guard for a one-off check. */
function isAxiosNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    typeof (err as { response?: { status?: number } }).response?.status === 'number' &&
    (err as { response: { status: number } }).response.status === 404
  );
}
