// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, registerComplianceEventSubscriber, requireFeature, requirePermission } from '@pipeline-builder/api-core';
import { createApp, runServer, createProtectedRoute, createAuthenticatedWithOrgRoute, attachRequestContext, postgresHealthCheck, redisHealthCheck, combineHealthChecks } from '@pipeline-builder/api-server';

import { startWorker, waitForWorkerReady, shutdownQueue, getHealthRedisConnection } from './queue/plugin-build-queue.js';
import { createBulkPluginRoutes } from './routes/bulk-plugin.js';
import { createDeletePluginRoutes } from './routes/delete-plugin.js';
import { createDeployGeneratedPluginRoutes } from './routes/deploy-generated-plugin.js';
import { createGeneratePluginRoutes } from './routes/generate-plugin.js';
import { createQueueStatusRoutes } from './routes/queue-status.js';
import { createReadPluginRoutes } from './routes/read-plugins.js';
import { createUpdatePluginRoutes } from './routes/update-plugin.js';
import { createUploadPluginRoutes } from './routes/upload-plugin.js';

const logger = createLogger('plugin');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({
  // Plugin depends on BOTH postgres and redis (the BullMQ build queue) — probe
  // each in parallel rather than reporting redis as always-connected.
  checkDependencies: combineHealthChecks(
    () => postgresHealthCheck(),
    redisHealthCheck(() => getHealthRedisConnection()),
  ),
});

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- Upload route FIRST — manages its own middleware (multer → auth → plugins quota).
//    Must be registered before other /plugins routes so that their auth/quota
//    middleware does not run on multipart uploads before multer can parse the body.
app.use('/plugins', createUploadPluginRoutes(quotaService));

// -- Queue status route (MUST be before read routes to avoid /:id catching "queue")
app.use('/plugins/queue', ...createAuthenticatedWithOrgRoute(), createQueueStatusRoutes(quotaService));

// -- AI generation routes — ai_generation feature gate (MUST be before read routes)
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), requireFeature('ai_generation'), createGeneratePluginRoutes(quotaService));

// -- Deploy AI-generated plugin — manages its own admin + quota middleware
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), createDeployGeneratedPluginRoutes(quotaService));

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/plugins', ...createProtectedRoute(quotaService, 'apiCalls'), createReadPluginRoutes(quotaService));

// -- Update route — auth + orgId + plugins:write (no quota check) -------------
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), requirePermission('plugins:write'), createUpdatePluginRoutes());

// -- Delete route — auth + orgId + plugins:write (admin-only also in handler) -
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), requirePermission('plugins:write'), createDeletePluginRoutes());

// -- Bulk routes — auth + orgId + plugins:write + bulk_operations feature gate -
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), requirePermission('plugins:write'), requireFeature('bulk_operations'), createBulkPluginRoutes());

// -- Start BullMQ worker for async Docker builds ----------------------------
startWorker(sseManager, quotaService);

// -- Register compliance event subscriber for entity lifecycle events --------
// `'plugin'` is the service principal baked into the signed JWT the
// subscriber mints per event (the compliance route requires a service
// principal — the previous spoofable `x-internal-service` header is gone).
registerComplianceEventSubscriber(undefined, 'plugin');

logger.info('All /plugins routes registered');

void runServer(app, {
  name: 'Plugin Service',
  sseManager,
  onBeforeStart: () => waitForWorkerReady(),
  onShutdown: () => shutdownQueue(),
});
