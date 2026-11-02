// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendError,
  ErrorCode,
  getParam,
  audited,
  requirePermission,
  requireAssurance,
  requireSystemOrgPermission,
  createLogger,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { runRegistryGc } from '../services/registry-gc.js';
import { computeStorageUsage } from '../services/storage-usage.js';
import { canReadRepo } from './images/repo-access.js';

const logger = createLogger('admin-routes');

/**
 * Format a repo namespace prefix for the per-org rollup. Accepts either
 * `org-acme` or `org-acme/`; always normalizes to the trailing-slash form
 * so prefix matching is precise (e.g. `org-acme/` won't match `org-acme-2/`).
 */
function normalizePrefix(p: string): string {
  return p.endsWith('/') ? p : `${p}/`;
}

const GcSchema = z.object({
  /** Repo namespace to GC. Must end with `/` or will be auto-appended. */
  prefix: z.string().min(1),
  /** Manifests older than this many days are pruned. */
  maxAgeDays: z.number().int().min(1).max(3650).optional(),
  /** When true, walk + log candidates without issuing DELETEs. */
  dryRun: z.boolean().optional(),
});

/**
 * Admin endpoints — storage rollup + manual GC, gated per-route at the two
 * different blast radii the registry permissions now distinguish:
 *
 *  - GET /api/admin/storage/:prefix — a READ (`registry:read`, system-org-only,
 *    so it takes the composed system-org + aal2 chain), narrowed further to the
 *    namespaces the caller may actually read;
 *  - POST /api/admin/gc — a PURGE (`registry:purge`, superadmin-only) with
 *    step-up, since it deletes manifests across a whole namespace at once.
 *
 * `requireAuth` runs at mount time (see src/index.ts) so `req.user` is always
 * populated here.
 */
export function createAdminRoutes(): Router {
  const router = Router();

  // GET /api/admin/storage/:prefix — per-namespace storage rollup.
  // Cached for 60s (see storage-usage.ts).
  router.get('/storage/:prefix', ...(requireSystemOrgPermission('registry:read') as RequestHandler[]), withRoute(async ({ req, res, ctx }) => {
    const raw = getParam(req.params, 'prefix');
    if (!raw) return sendBadRequest(res, 'prefix is required', ErrorCode.MISSING_REQUIRED_FIELD);
    const prefix = normalizePrefix(raw);
    // The same per-repo ownership filter the listing applies, for the same
    // reason: `registry:read` is held by Roles now, not just the flag, and a
    // byte total for `org-acme/` is a cross-tenant fact. `canReadRepo` keys off
    // the namespace, so a sentinel repo name under the prefix answers for the
    // whole namespace.
    if (!canReadRepo(req.user, `${prefix}_`)) {
      return sendError(res, 403, `Forbidden: namespace "${prefix}" is outside your organization.`, ErrorCode.ORG_MISMATCH, { reason: 'repo-not-owned', prefix, access: 'read' });
    }
    const force = req.query.force === 'true';

    const usage = await computeStorageUsage(prefix, { force });
    ctx.log('COMPLETED', 'Computed storage rollup', { prefix, bytes: usage.bytes });
    return sendSuccess(res, 200, usage);
  }));

  // POST /api/admin/gc — prune old manifests under a repo namespace.
  // Body: { prefix: 'org-acme/', maxAgeDays: 30, dryRun: false }
  router.post('/gc', requirePermission('registry:purge') as RequestHandler, requireAssurance({ minAssurance: 2 }) as RequestHandler, audited('registry.gc'), withRoute(async ({ req, res, ctx }) => {
    const validation = validateBody(req, GcSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const { prefix, maxAgeDays, dryRun } = validation.value;

    const result = await runRegistryGc({
      prefix: normalizePrefix(prefix),
      ...(maxAgeDays !== undefined && { maxAgeDays }),
      ...(dryRun !== undefined && { dryRun }),
      // Attribute the manual GC to the calling sysadmin; the scheduler path
      // leaves these unset so runRegistryGc falls back to actorId 'system'.
      ...(req.user?.sub && { actorId: req.user.sub }),
      ...(req.user?.email && { actorEmail: req.user.email }),
      ...(req.user?.organizationId && { actorOrgId: req.user.organizationId }),
    });

    logger.info('Registry GC run', {
      prefix,
      maxAgeDays,
      dryRun,
      reposScanned: result.reposScanned,
      candidates: result.candidates,
      deleted: result.deleted,
    });
    ctx.log('COMPLETED', 'Registry GC run', {
      prefix, deleted: result.deleted, candidates: result.candidates,
    });
    return sendSuccess(res, 200, result);
  }));

  return router;
}
