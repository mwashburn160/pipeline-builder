// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendError,
  ErrorCode,
  getParam,
  isSystemAdmin,
  createLogger,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { runRegistryGc } from '../services/registry-gc';
import { computeStorageUsage } from '../services/storage-usage';

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

/** Sysadmin guard — matches the pattern used in routes/images.ts. */
function requireSystemAdminGuard(req: Request, res: Response): boolean {
  if (!isSystemAdmin(req)) {
    sendError(res, 403, 'System admin access required', ErrorCode.INSUFFICIENT_PERMISSIONS);
    return false;
  }
  return true;
}

/**
 * Admin endpoints — storage rollup + manual GC. All sysadmin-gated.
 *
 * Routes:
 *  - GET  /api/admin/storage/:prefix   — rollup bytes for one namespace
 *  - POST /api/admin/gc                — prune old manifests under a namespace
 */
export function createAdminRoutes(): Router {
  const router = Router();

  // GET /api/admin/storage/:prefix — per-namespace storage rollup.
  // Cached for 60s (see storage-usage.ts).
  router.get('/storage/:prefix', withRoute(async ({ req, res, ctx }) => {
    if (!requireSystemAdminGuard(req, res)) return;
    const raw = getParam(req.params, 'prefix');
    if (!raw) return sendBadRequest(res, 'prefix is required', ErrorCode.MISSING_REQUIRED_FIELD);
    const prefix = normalizePrefix(raw);
    const force = req.query.force === 'true';

    const usage = await computeStorageUsage(prefix, { force });
    ctx.log('COMPLETED', 'Computed storage rollup', { prefix, bytes: usage.bytes });
    return sendSuccess(res, 200, usage);
  }));

  // POST /api/admin/gc — prune old manifests under a repo namespace.
  // Body: { prefix: 'org-acme/', maxAgeDays: 30, dryRun: false }
  router.post('/gc', withRoute(async ({ req, res, ctx }) => {
    if (!requireSystemAdminGuard(req, res)) return;
    const parsed = GcSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return sendBadRequest(res, msg, ErrorCode.VALIDATION_ERROR);
    }
    const { prefix, maxAgeDays, dryRun } = parsed.data;

    const result = await runRegistryGc({
      prefix: normalizePrefix(prefix),
      ...(maxAgeDays !== undefined && { maxAgeDays }),
      ...(dryRun !== undefined && { dryRun }),
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
