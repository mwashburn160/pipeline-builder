/**
 * @module pipeline
 * @description Pipeline microservice.
 *
 * Routes mounted under /pipelines:
 *
 *   GET    /pipelines        — list with pagination, filtering, sorting
 *   GET    /pipelines/find   — find single pipeline by query-string filters
 *   GET    /pipelines/:id    — get by UUID
 *   POST   /pipelines        — create new pipeline
 *   PUT    /pipelines/:id    — update existing pipeline
 *   DELETE /pipelines/:id    — delete existing pipeline
 */

import { createLogger } from '@mwashburn160/api-core';
import { createApp, runServer, authenticateToken, createQuotaService } from '@mwashburn160/api-server';
import { RequestHandler } from 'express';

import { checkQuota } from './middleware/check-quota';
import { requireOrgId } from './middleware/require-org-id';
import { createCreatePipelineRoutes } from './routes/create-pipeline';
import { createDeletePipelineRoutes } from './routes/delete-pipeline';
import { createReadPipelineRoutes } from './routes/read-pipelines';
import { createUpdatePipelineRoutes } from './routes/update-pipeline';

const logger = createLogger('pipeline');
const quotaService = createQuotaService();
const { app, sseManager } = createApp();

// -- Shared middleware for authenticated routes --------------------------------
const auth: RequestHandler = authenticateToken as RequestHandler;
const orgId: RequestHandler = requireOrgId(sseManager);
const apiQuota: RequestHandler = checkQuota(quotaService, sseManager, 'apiCalls') as RequestHandler;

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/pipelines', auth, orgId, apiQuota, createReadPipelineRoutes(sseManager, quotaService));

// -- Update route — auth + orgId (no quota check) ----------------------------
app.use('/pipelines', auth, orgId, createUpdatePipelineRoutes(sseManager));

// -- Delete route — auth + orgId (admin-only, enforced in handler) -----------
app.use('/pipelines', auth, orgId, createDeletePipelineRoutes(sseManager));

// -- Create route — manages its own middleware (uses 'pipelines' quota) -------
app.use('/pipelines', createCreatePipelineRoutes(sseManager, quotaService));

logger.info('All /pipelines routes registered');

void runServer(app, { name: 'Pipeline Service', sseManager });
