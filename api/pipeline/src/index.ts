// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, registerComplianceEventSubscriber, requireFeature } from '@pipeline-builder/api-core';
import { createApp, runServer, createProtectedRoute, createAuthenticatedWithOrgRoute, attachRequestContext, postgresHealthCheck } from '@pipeline-builder/api-server';
import { runMigrations } from '@pipeline-builder/pipeline-core';

import { createBulkPipelineRoutes } from './routes/bulk-pipeline';
import { createCreatePipelineRoutes } from './routes/create-pipeline';
import { createDeletePipelineRoutes } from './routes/delete-pipeline';
import { createGeneratePipelineRoutes } from './routes/generate-pipeline';
import { createReadPipelineRoutes } from './routes/read-pipelines';
import { createRegistryRoutes } from './routes/registry';
import { createUpdatePipelineRoutes } from './routes/update-pipeline';

const logger = createLogger('pipeline');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({ checkDependencies: postgresHealthCheck });

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- Create route FIRST — manages its own middleware (uses 'pipelines' quota).
//    Must be before read routes so POST /pipelines doesn't run through the
//    read routes' apiCalls quota check unnecessarily.
app.use('/pipelines', createCreatePipelineRoutes(quotaService));

// -- AI generation routes — auth + orgId + ai_generation feature gate --------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), requireFeature('ai_generation'), createGeneratePipelineRoutes(quotaService));

// -- Registry route — must be BEFORE read routes so `/registry` doesn't get
//    swallowed by read's `/:id` matcher (would 404 with "Pipeline not found.")
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), createRegistryRoutes());

// -- Bulk routes — auth + orgId + bulk_operations feature gate ---------------
//    Also before read routes — `/bulk/create` must not hit `/:id`.
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), requireFeature('bulk_operations'), createBulkPipelineRoutes());

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/pipelines', ...createProtectedRoute(quotaService, 'apiCalls'), createReadPipelineRoutes(quotaService));

// -- Update route — auth + orgId (no quota check) ----------------------------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), createUpdatePipelineRoutes());

// -- Delete route — auth + orgId (admin-only, enforced in handler) -----------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), createDeletePipelineRoutes());

// -- Register compliance event subscriber for entity lifecycle events --------
registerComplianceEventSubscriber();

logger.info('All /pipelines routes registered');

void runServer(app, {
  name: 'Pipeline Service',
  sseManager,
  // Run any pending Drizzle migrations before opening the listening socket.
  // Idempotent and a no-op when ./drizzle/ has no journal yet.
  onBeforeStart: () => runMigrations(),
});
