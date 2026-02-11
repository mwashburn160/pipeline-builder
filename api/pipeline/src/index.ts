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
import { createApp, runServer, createQuotaService, createProtectedRoute, createAuthenticatedWithOrgRoute, attachRequestContext } from '@mwashburn160/api-server';

import { createCreatePipelineRoutes } from './routes/create-pipeline';
import { createDeletePipelineRoutes } from './routes/delete-pipeline';
import { createReadPipelineRoutes } from './routes/read-pipelines';
import { createUpdatePipelineRoutes } from './routes/update-pipeline';

const logger = createLogger('pipeline');
const quotaService = createQuotaService();
const { app, sseManager } = createApp();

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/pipelines', ...createProtectedRoute(sseManager, quotaService, 'apiCalls'), createReadPipelineRoutes(sseManager, quotaService));

// -- Update route — auth + orgId (no quota check) ----------------------------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(sseManager), createUpdatePipelineRoutes(sseManager));

// -- Delete route — auth + orgId (admin-only, enforced in handler) -----------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(sseManager), createDeletePipelineRoutes(sseManager));

// -- Create route — manages its own middleware (uses 'pipelines' quota) -------
app.use('/pipelines', createCreatePipelineRoutes(sseManager, quotaService));

logger.info('All /pipelines routes registered');

void runServer(app, { name: 'Pipeline Service', sseManager });
