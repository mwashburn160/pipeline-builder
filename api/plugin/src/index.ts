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
import { createApp, runServer, authenticateToken, createQuotaService } from '@mwashburn160/api-server';
import { RequestHandler } from 'express';

import { checkQuota } from './middleware/check-quota';
import { requireOrgId } from './middleware/require-org-id';
import { createDeletePluginRoutes } from './routes/delete-plugin';
import { createReadPluginRoutes } from './routes/read-plugins';
import { createUpdatePluginRoutes } from './routes/update-plugin';
import { createUploadPluginRoutes } from './routes/upload-plugin';

const logger = createLogger('plugin');
const quotaService = createQuotaService();
const { app, sseManager } = createApp();

// -- Shared middleware for authenticated routes --------------------------------
const auth: RequestHandler = authenticateToken as RequestHandler;
const orgId: RequestHandler = requireOrgId(sseManager);
const apiQuota: RequestHandler = checkQuota(quotaService, sseManager, 'apiCalls') as RequestHandler;

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/plugins', auth, orgId, apiQuota, createReadPluginRoutes(sseManager, quotaService));

// -- Update route — auth + orgId (no quota check) ----------------------------
app.use('/plugins', auth, orgId, createUpdatePluginRoutes(sseManager));

// -- Delete route — auth + orgId (admin-only, enforced in handler) -----------
app.use('/plugins', auth, orgId, createDeletePluginRoutes(sseManager));

// -- Upload route — manages its own middleware (multer → auth → plugins quota)
app.use('/plugins', createUploadPluginRoutes(sseManager, quotaService));

logger.info('All /plugins routes registered');

void runServer(app, { name: 'Plugin Service', sseManager });
