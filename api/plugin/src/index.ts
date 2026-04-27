// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, registerComplianceEventSubscriber, requireFeature } from '@pipeline-builder/api-core';
import { createApp, runServer, createProtectedRoute, createAuthenticatedWithOrgRoute, attachRequestContext, postgresHealthCheck } from '@pipeline-builder/api-server';

import { startWorker, waitForWorkerReady, shutdownQueue } from './queue/plugin-build-queue';
import { createBulkPluginRoutes } from './routes/bulk-plugin';
import { createDeletePluginRoutes } from './routes/delete-plugin';
import { createDeployGeneratedPluginRoutes } from './routes/deploy-generated-plugin';
import { createGeneratePluginRoutes } from './routes/generate-plugin';
import { createQueueStatusRoutes } from './routes/queue-status';
import { createReadPluginRoutes } from './routes/read-plugins';
import { createUpdatePluginRoutes } from './routes/update-plugin';
import { createUploadPluginRoutes } from './routes/upload-plugin';

const logger = createLogger('plugin');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({
  checkDependencies: async () => ({ ...(await postgresHealthCheck()), redis: 'connected' }),
});

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- Upload route FIRST — manages its own middleware (multer → auth → plugins quota).
//    Must be registered before other /plugins routes so that their auth/quota
//    middleware does not run on multipart uploads before multer can parse the body.
app.use('/plugins', createUploadPluginRoutes(quotaService));

// -- Queue status route (MUST be before read routes to avoid /:id catching "queue")
app.use('/plugins/queue', ...createAuthenticatedWithOrgRoute(), createQueueStatusRoutes());

// -- AI generation routes — ai_generation feature gate (MUST be before read routes)
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), requireFeature('ai_generation'), createGeneratePluginRoutes(quotaService));

// -- Deploy AI-generated plugin — manages its own admin + quota middleware
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), createDeployGeneratedPluginRoutes(quotaService));

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/plugins', ...createProtectedRoute(quotaService, 'apiCalls'), createReadPluginRoutes(quotaService));

// -- Update route — auth + orgId (no quota check) ----------------------------
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), createUpdatePluginRoutes());

// -- Delete route — auth + orgId (admin-only, enforced in handler) -----------
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), createDeletePluginRoutes());

// -- Bulk routes — auth + orgId + bulk_operations feature gate ---------------
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), requireFeature('bulk_operations'), createBulkPluginRoutes());

// -- Start BullMQ worker for async Docker builds ----------------------------
startWorker(sseManager, quotaService);

// -- Register compliance event subscriber for entity lifecycle events --------
registerComplianceEventSubscriber();

logger.info('All /plugins routes registered');

void runServer(app, {
  name: 'Plugin Service',
  sseManager,
  onBeforeStart: () => waitForWorkerReady(),
  onShutdown: () => shutdownQueue(),
});
