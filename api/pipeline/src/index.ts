// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, registerComplianceEventSubscriber, requirePermission, wireAuthzDenialAuditor, setTokenRevocationStore, createEnvRedisTokenRevocationStore } from '@pipeline-builder/api-core';
import { createApp, runServer, createProtectedRoute, createAuthenticatedWithOrgRoute, attachRequestContext, postgresHealthCheck } from '@pipeline-builder/api-server';
import { runMigrations } from '@pipeline-builder/pipeline-data';

import { createBulkPipelineRoutes } from './routes/bulk-pipeline.js';
import { createCreatePipelineRoutes } from './routes/create-pipeline.js';
import { createDeletePipelineRoutes } from './routes/delete-pipeline.js';
import { createExecutionRoutes } from './routes/executions.js';
import { createGeneratePipelineRoutes } from './routes/generate-pipeline.js';
import { createPipelineTemplateRoutes } from './routes/pipeline-template-routes.js';
import { createReadPipelineRoutes } from './routes/read-pipelines.js';
import { createRegistryRoutes } from './routes/registry.js';
import { createScorecardRoutes } from './routes/scorecard-routes.js';
import { createUpdatePipelineRoutes } from './routes/update-pipeline.js';
import { getAuditClient } from './services/audit.js';

const logger = createLogger('pipeline');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({ checkDependencies: postgresHealthCheck });

// Forward denied (non-GET) requests to the shared authz.denied audit sink.
wireAuthzDenialAuditor('pipeline', getAuditClient);

// Reject tokens whose tokenVersion is behind the platform-published value once
// Redis is configured; fail-open (no-op) otherwise — falls back to token expiry.
setTokenRevocationStore(createEnvRedisTokenRevocationStore());

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- Create route FIRST — manages its own middleware (uses 'pipelines' quota).
//    Must be before read routes so POST /pipelines doesn't run through the
//    read routes' apiCalls quota check unnecessarily.
app.use('/pipelines', createCreatePipelineRoutes(quotaService));

// -- AI generation routes — mounted plainly. Each route owns its auth + orgId +
//    ai_generation feature gate (see generate-pipeline.ts), so the feature guard
//    can't leak onto sibling reads under the shared '/pipelines' prefix.
app.use('/pipelines', createGeneratePipelineRoutes(quotaService));

// -- Registry route — must be BEFORE read routes so `/registry` doesn't get
//    swallowed by read's `/:id` matcher (would 404 with "Pipeline not found.")
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), createRegistryRoutes());

// -- Bulk routes — mounted plainly. Each route owns its auth + orgId +
//    pipelines:write + bulk_operations feature gate (see bulk-pipeline.ts), so
//    those guards can't leak onto sibling reads. Still before read routes —
//    `/bulk/create` must not hit `/:id`.
app.use('/pipelines', createBulkPipelineRoutes(quotaService));

// -- Execution write routes (trigger / cancel via AWS CodePipeline) ----------
//    Mounted plainly. Each POST-only route owns its auth + orgId +
//    pipelines:write gate (see executions.ts), so the write permission can't
//    leak onto sibling reads. Paths (`/:pipelineId/executions` and
//    `.../:executionId/stop`) won't collide with the read GET `/:id`.
app.use('/pipelines', createExecutionRoutes());

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/pipelines', ...createProtectedRoute(quotaService, 'apiCalls'), createReadPipelineRoutes(quotaService));

// -- Per-pipeline maturity scorecard — auth + org + apiCalls quota (metered
//    like the other reads), + advanced_reporting per-route inside. MUST be
//    mounted BEFORE the write-gated update/delete routes below: those apply
//    requirePermission('pipelines:write') as a PREFIX layer that would otherwise
//    run for GET /pipelines/:id/scorecard (a read) and 403 read-only viewers.
//    The two-segment path (/:id/scorecard) doesn't clash with the read /:id.
app.use('/pipelines', ...createProtectedRoute(quotaService, 'apiCalls'), createScorecardRoutes(quotaService));

// -- Update route — auth + orgId + pipelines:write ---------------------------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:write'), createUpdatePipelineRoutes());

// -- Delete route — auth + orgId + pipelines:write ---------------------------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:write'), createDeletePipelineRoutes());

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

void runServer(app, {
  name: 'Pipeline Service',
  sseManager,
  // Run any pending Drizzle migrations before opening the listening socket.
  // Idempotent and a no-op when ./drizzle/ has no journal yet.
  onBeforeStart: () => runMigrations(),
});
