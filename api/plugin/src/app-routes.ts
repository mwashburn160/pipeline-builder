// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requirePermission, requireStepUp, type QuotaService } from '@pipeline-builder/api-core';
import { checkQuota, createAuthenticatedWithOrgRoute, type SSEManager } from '@pipeline-builder/api-server';
import type { Express } from 'express';

import { createBulkPluginRoutes } from './routes/bulk-plugin.js';
import { createDeletePluginRoutes } from './routes/delete-plugin.js';
import { createDeployGeneratedPluginRoutes } from './routes/deploy-generated-plugin.js';
import { createGeneratePluginRoutes } from './routes/generate-plugin.js';
import { createPurgePluginRoutes } from './routes/purge-plugin.js';
import { createQueueStatusRoutes } from './routes/queue-status.js';
import { createReadPluginRoutes } from './routes/read-plugins.js';
import { createRestorePluginRoutes } from './routes/restore-plugin.js';
import { createUpdatePluginRoutes } from './routes/update-plugin.js';
import { createUploadPluginRoutes } from './routes/upload-plugin.js';

/** Dependencies the route factories need. */
export interface PluginRouteDeps {
  quotaService: QuotaService;
  sseManager: SSEManager;
}

/**
 * Mount every plugin-service route on `app`. Shared by `index.ts` (the running
 * service) and the route-coverage test, so the route table the test checks is
 * the one production serves.
 */
export function mountRoutes(app: Express, { quotaService, sseManager }: PluginRouteDeps): void {
  // -- Upload route FIRST — manages its own middleware (auth → orgId →
  //    plugins:write → rate limit → multer → tenant scope). Must be registered
  //    before the shared chain below so no auth/quota middleware runs on a
  //    multipart upload before multer can parse the body. It only matches
  //    `POST /plugins`; everything else falls straight through.
  app.use('/plugins', createUploadPluginRoutes(quotaService, sseManager));

  // -- ONE shared auth + orgId + idempotency + tenant-scope pass ---------------
  // Every remaining /plugins route shares this single prefix chain, and each
  // mount below adds only its own gates. Stacking a separate
  // `createAuthenticatedWithOrgRoute()` / `createProtectedRoute()` in front of
  // each router re-ran the idempotency middleware for every mount a request fell
  // through: the second pass found the FIRST pass's pending reservation under the
  // same key and answered 409 (e.g. `POST /plugins/deploy-generated` with an
  // Idempotency-Key, which falls through the generate mount first).
  //
  // Gates added by a mount are PREFIX layers, so they also run for every request
  // that falls through to a later mount — the order below is load-bearing.
  app.use('/plugins', ...createAuthenticatedWithOrgRoute());

  // -- Queue status routes (MUST be before read routes so `/:id` can't catch "queue").
  //    Every route owns its gate (requireSystemAdmin for the cross-org operator
  //    views, plugins:write for the org-scoped ones) so nothing leaks onto reads.
  app.use('/plugins/queue', createQueueStatusRoutes(quotaService));

  // -- AI generation routes (MUST be before read routes). The `ai_generation`
  //    feature gate lives on each generate route inside the router (see
  //    generate-plugin.ts) so it can't leak onto sibling `GET /plugins` reads.
  app.use('/plugins', createGeneratePluginRoutes(quotaService));

  // -- Deploy AI-generated plugin — owns its plugins:write gate + quota reservation.
  app.use('/plugins', createDeployGeneratedPluginRoutes(quotaService, sseManager));

  // -- Read routes (list, find, get-by-id) — + apiCalls quota check. The check is a
  //    prefix layer, so the write mounts below it are metered the same way.
  //    `plugins:read` is enforced PER ROUTE inside the router (a prefix-layer
  //    read gate would also run for the write mounts below, which a writer
  //    without :read would then fail).
  app.use('/plugins', checkQuota(quotaService, 'apiCalls'), createReadPluginRoutes(quotaService));

  // -- Write routes — + plugins:write, ONE mount so the gate runs once --------
  //   - update / delete: plugins:write (delete's per-row publish gate is in-handler).
  //   - bulk: + `bulk_operations`, attached per route inside the router so the
  //     feature gate can't leak onto purge/restore. Mounted BEFORE `requireStepUp`
  //     so bulk calls don't require (and aren't blocked by) a step-up token.
  //   - purge / restore: + step-up (password re-verify). Purge is an irreversible
  //     hard-delete of a tombstone; restore reverses a soft-delete. `requireStepUp`
  //     consumes the step-up token's `jti` ONCE, so both routers sit behind a
  //     SINGLE step-up layer: a separate step-up mount per router made whichever
  //     came second see its own already-consumed jti (401 STEP_UP_REPLAY), and
  //     anything mounted after both (bulk) hit STEP_UP_REQUIRED.
  app.use(
    '/plugins',
    requirePermission('plugins:write'),
    createUpdatePluginRoutes(),
    createDeletePluginRoutes(),
    createBulkPluginRoutes(),
    requireStepUp,
    createPurgePluginRoutes(),
    createRestorePluginRoutes(),
  );
}
