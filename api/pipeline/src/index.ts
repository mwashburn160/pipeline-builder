// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, registerComplianceEventSubscriber, requirePermission, requireStepUp, wireServiceSecurity } from '@pipeline-builder/api-core';
import { createApp, runServer, checkQuota, createAuthenticatedWithOrgRoute, attachRequestContext, postgresHealthCheck } from '@pipeline-builder/api-server';
import { createSoftDeletePurgeScheduler } from '@pipeline-builder/pipeline-data';

import { createBulkPipelineRoutes } from './routes/bulk-pipeline.js';
import { createCreatePipelineRoutes } from './routes/create-pipeline.js';
import { createDeletePipelineRoutes } from './routes/delete-pipeline.js';
import { createExecutionRoutes } from './routes/executions.js';
import { createGeneratePipelineRoutes } from './routes/generate-pipeline.js';
import { createPipelineTemplateRoutes } from './routes/pipeline-template-routes.js';
import { createPurgePipelineRoutes } from './routes/purge-pipeline.js';
import { createReadPipelineRoutes } from './routes/read-pipelines.js';
import { createRegistryRoutes } from './routes/registry.js';
import { createRestorePipelineRoutes } from './routes/restore-pipeline.js';
import { createScorecardRoutes } from './routes/scorecard-routes.js';
import { createUpdatePipelineRoutes } from './routes/update-pipeline.js';
import { getAuditClient } from './services/audit.js';
import { pipelineService } from './services/pipeline-service.js';
import { pipelineTemplateService } from './services/pipeline-template-service.js';

const logger = createLogger('pipeline');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({ checkDependencies: postgresHealthCheck });

// Forward denied (non-GET) requests to the shared authz.denied audit sink.
wireServiceSecurity('pipeline', getAuditClient);

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

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
//      `createAuthenticatedWithOrgRoute()` / `createProtectedRoute()` mounts was
//      rejected by its own second pass (PUT /:id, DELETE /:id, POST /:id/purge,
//      POST /:id/restore, and /bulk/* behind the old registry chain). The
//      remaining gates (apiCalls quota, pipelines:write, step-up) are layered
//      as plain middleware on the later mounts, each still running once.

// -- Self-guarded routers (per-route auth chains) ----------------------------
//    - create: its own 'pipelines' quota reserve (no apiCalls pre-flight).
//    - generate: auth + orgId + ai_generation feature gate per route.
//    - bulk: auth + orgId + pipelines:write + bulk_operations per route.
//    - executions: POST-only, auth + orgId + pipelines:write per route.
//    None of their guards leak onto sibling reads, and their literal/two-segment
//    paths (`/bulk/create`, `/:pipelineId/executions`) are claimed before the
//    read router's `/:id`.
app.use('/pipelines', createCreatePipelineRoutes(quotaService));
app.use('/pipelines', createGeneratePipelineRoutes(quotaService));
app.use('/pipelines', createBulkPipelineRoutes(quotaService));
app.use('/pipelines', createExecutionRoutes(quotaService));

// -- Shared chain: auth + orgId + idempotency + tenant scope, ONCE ------------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute());

// -- Registry — no quota; writes gate on pipelines:write per route. Before the
//    read router so `/registry` isn't swallowed by `/:id`.
app.use('/pipelines', createRegistryRoutes());

// -- Reads + scorecards — apiCalls quota ------------------------------------
//    Scorecard routes mount BEFORE the read router: read's `GET /:id` would
//    otherwise capture `GET /pipelines/scorecard` (the org roll-up) as a
//    pipeline lookup and 404. Mounting them ahead of the write gate below also
//    keeps `GET /:id/scorecard` (a read) from hitting requirePermission('pipelines:write').
//    `advanced_reporting` is enforced per route inside the scorecard router.
app.use('/pipelines', checkQuota(quotaService, 'apiCalls'), createScorecardRoutes(quotaService), createReadPipelineRoutes(quotaService));

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
// +pipelines:write), so it mounts bare like the create route.
app.use('/pipeline-templates', createPipelineTemplateRoutes());

// -- Register compliance event subscriber for entity lifecycle events --------
// `'pipeline'` is the service principal baked into the signed JWT the
// subscriber mints per event (the compliance route requires a service
// principal — the previous spoofable `x-internal-service` header is gone).
registerComplianceEventSubscriber(undefined, 'pipeline');

logger.info('All /pipelines routes registered');

// Retention purge: hard-delete pipeline + pipeline_template tombstones past
// their `purge_after` deadline. Leader-locked (one replica per window) and
// sysadmin-scoped inside the sweep so it spans all orgs. Opt out with
// SOFT_DELETE_PURGE_ENABLED=false. Created before runServer so its teardown
// rides runServer's coordinated onShutdown (not a racing process.once).
const purgeScheduler = createSoftDeletePurgeScheduler({
  service: 'pipeline',
  entities: [
    { name: 'pipeline', purgeExpired: (now, limit) => pipelineService.purgeExpired(now, limit) },
    { name: 'pipeline_template', purgeExpired: (now, limit) => pipelineTemplateService.purgeExpired(now, limit) },
  ],
});

void runServer(app, {
  name: 'Pipeline Service',
  sseManager,
  // No boot-time migrations: the schema is owned by postgres-init.sql and the
  // service connects as a non-superuser app role without DDL rights.
  onShutdown: async () => { purgeScheduler?.stop(); },
});
purgeScheduler?.start();
