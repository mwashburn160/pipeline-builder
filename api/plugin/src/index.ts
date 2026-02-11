/**
 * @module plugin
 * @description Plugin microservice.
 *
 * Routes mounted under /plugins:
 *
 *   GET    /plugins        — list with pagination, filtering, sorting
 *   GET    /plugins/find   — find single plugin by query-string filters
 *   GET    /plugins/:id    — get by UUID
 *   POST   /plugins        — upload ZIP, build Docker image, store metadata
 *   PUT    /plugins/:id    — update existing plugin
 *   DELETE /plugins/:id    — delete existing plugin
 */

import { createLogger } from '@mwashburn160/api-core';
import { createApp, runServer, createQuotaService, createProtectedRoute, createAuthenticatedWithOrgRoute, attachRequestContext } from '@mwashburn160/api-server';

import { createDeletePluginRoutes } from './routes/delete-plugin';
import { createReadPluginRoutes } from './routes/read-plugins';
import { createUpdatePluginRoutes } from './routes/update-plugin';
import { createUploadPluginRoutes } from './routes/upload-plugin';

const logger = createLogger('plugin');
const quotaService = createQuotaService();
const { app, sseManager } = createApp();

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/plugins', ...createProtectedRoute(sseManager, quotaService, 'apiCalls'), createReadPluginRoutes(sseManager, quotaService));

// -- Update route — auth + orgId (no quota check) ----------------------------
app.use('/plugins', ...createAuthenticatedWithOrgRoute(sseManager), createUpdatePluginRoutes(sseManager));

// -- Delete route — auth + orgId (admin-only, enforced in handler) -----------
app.use('/plugins', ...createAuthenticatedWithOrgRoute(sseManager), createDeletePluginRoutes(sseManager));

// -- Upload route — manages its own middleware (multer → auth → plugins quota)
app.use('/plugins', createUploadPluginRoutes(sseManager, quotaService));

logger.info('All /plugins routes registered');

void runServer(app, { name: 'Plugin Service', sseManager });
