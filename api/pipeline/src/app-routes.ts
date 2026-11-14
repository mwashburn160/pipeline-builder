// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requirePermission, requireStepUp, type QuotaService } from '@pipeline-builder/api-core';
import { apiCallsQuota, createAuthenticatedWithOrgRoute } from '@pipeline-builder/api-server';
import type { Express } from 'express';

import { createBulkPipelineRoutes } from './routes/bulk-pipeline.js';
import { createCreatePipelineRoutes } from './routes/create-pipeline.js';
import { createDeletePipelineRoutes } from './routes/delete-pipeline.js';
import { createExecutionRoutes } from './routes/executions.js';
import { createGeneratePipelineRoutes } from './routes/generate-pipeline.js';
import { createPipelineTemplateRoutes } from './routes/pipeline-template-routes.js';
import { createPluginUpgradeRoutes } from './routes/plugin-upgrade-routes.js';
import { createPurgePipelineRoutes } from './routes/purge-pipeline.js';
import { createReadPipelineRoutes } from './routes/read-pipelines.js';
import { createRegistryRoutes } from './routes/registry.js';
import { createRestorePipelineRoutes } from './routes/restore-pipeline.js';
import { createScorecardRoutes } from './routes/scorecard-routes.js';
import { createSecurityReportRoutes } from './routes/security-report-routes.js';
import { createUpdatePipelineRoutes } from './routes/update-pipeline.js';
import { createValidatePipelineRoutes } from './routes/validate-pipeline.js';

/** Dependencies the route factories need. */
export interface PipelineRouteDeps {
  quotaService: QuotaService;
}

/**
 * Mount every pipeline-service route on `app`. Shared by `index.ts` (the running
 * service) and the route-coverage test, so the route table the test checks is
 * the one production serves.
 */
export function mountRoutes(app: Express, { quotaService }: PipelineRouteDeps): void {
  // -- apiCalls quota, ONCE per user prefix, ahead of every router under it ------
  // `apiCallsQuota` meters each 2xx and arms a check that api-core `requireAuth`
  // runs right after verifying the caller — so it covers the self-guarded routers
  // (per-route auth chains) and the shared chain alike, and no router under these
  // prefixes mounts its own apiCalls meter/check (that would bill twice). Service
  // principals and unauthenticated requests are skipped by both halves. Quotas of
  // OTHER types (create/bulk's 'pipelines' reservation, generate's 'aiCalls')
  // stay on their routes: an AI generation spends one apiCall AND one aiCall.
  app.use('/pipelines', ...apiCallsQuota(quotaService));
  app.use('/pipeline-templates', ...apiCallsQuota(quotaService));

  // -- /pipelines mount order ---------------------------------------------------
  // Express runs an `app.use('/pipelines', ...guards, router)` mount's guards for
  // EVERY request under the prefix that reaches it, whether or not that router
  // then matches. Two rules follow:
  //
  //   1. Self-guarded routers (each route owns its full chain) mount FIRST, so a
  //      request they serve never also runs a shared prefix chain.
  //   2. Everything else shares ONE auth chain, mounted ONCE. The api-server chain
  //      factories embed `idempotencyMiddleware`, which reserves the request's
  //      Idempotency-Key and 409s on seeing its own pending reservation — so a
  //      keyed POST/PUT/DELETE that fell through two stacked
  //      `createAuthenticatedWithOrgRoute()` / `createProtectedRoute()` mounts
  //      would be rejected by its own second pass. The
  //      remaining gates (pipelines:write, step-up) are layered as plain
  //      middleware on the later mounts, each still running once.

  // -- Self-guarded routers (per-route auth chains) ----------------------------
  //    - create: its own 'pipelines' quota reserve (+ apiCalls via the prefix).
  //    - generate: auth + orgId + ai_generation feature gate per route.
  //    - bulk: auth + orgId + pipelines:write + bulk_operations per route.
  //    - executions: POST-only, auth + orgId + pipelines:write per route.
  //    None of their guards leak onto sibling reads, and their literal/two-segment
  //    paths (`/bulk/create`, `/:pipelineId/executions`) are claimed before the
  //    read router's `/:id`.
  app.use('/pipelines', createCreatePipelineRoutes(quotaService));
  //    - validate: auth + orgId + pipelines:write per route. Writes nothing and
  //      reserves no 'pipelines' slot, so it is deliberately NOT behind the create mount's
  //      reservation; its literal `/validate` path is claimed before `/:id`.
  app.use('/pipelines', createValidatePipelineRoutes(quotaService));
  app.use('/pipelines', createGeneratePipelineRoutes(quotaService));
  app.use('/pipelines', createBulkPipelineRoutes(quotaService));
  app.use('/pipelines', createExecutionRoutes());
  //    - plugin upgrades + security reports: auth + orgId + their own permission
  //      per route (`/:id/plugin-upgrades/preview` is a READ despite being a POST,
  //      so it must not fall into the shared pipelines:write chain below).
  app.use('/pipelines', createPluginUpgradeRoutes());
  app.use('/pipelines', createSecurityReportRoutes());

  // -- Shared chain: auth + orgId + idempotency + tenant scope, ONCE ------------
  app.use('/pipelines', ...createAuthenticatedWithOrgRoute());

  // -- Registry — apiCalls via the prefix mount; writes gate on pipeline_registry:write per route. Before the
  //    read router so `/registry` isn't swallowed by `/:id`.
  app.use('/pipelines', createRegistryRoutes());

  // -- Reads + scorecards ------------------------------------------------------
  //    Scorecard routes mount BEFORE the read router: read's `GET /:id` would
  //    otherwise capture `GET /pipelines/scorecard` (the org roll-up) as a
  //    pipeline lookup and 404. Mounting them ahead of the write gate below also
  //    keeps `GET /:id/scorecard` (a read) from hitting requirePermission('pipelines:write').
  //    `advanced_reporting` is enforced per route inside the scorecard router.
  app.use('/pipelines', createScorecardRoutes(), createReadPipelineRoutes());

  // -- Writes — pipelines:write; purge + restore additionally need step-up -----
  // Purge (permanent hard-delete of a tombstone) and restore (undo a soft-delete)
  // are permanently-consequential and require a step-up (password re-verify). The
  // single-use `requireStepUp` gate consumes the step-up token's `jti`, so it must
  // run exactly once per request: it sits in this ONE chain after update/delete,
  // so only requests those routers didn't serve reach it, and a POST /:id/restore
  // falls through the purge router to the restore router without a second step-up.
  app.use(
    '/pipelines',
    requirePermission('pipelines:write'),
    createUpdatePipelineRoutes(),
    createDeletePipelineRoutes(),
    requireStepUp,
    createPurgePipelineRoutes(),
    createRestorePipelineRoutes(),
  );

  // -- Golden-path pipeline templates (list/get/instantiate + author) ----------
  // Middleware is applied per-route inside the router (reads: auth+org; writes:
  // +templates:write), so it mounts bare like the create route.
  app.use('/pipeline-templates', createPipelineTemplateRoutes());
}
