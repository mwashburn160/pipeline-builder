import { createLogger, createQuotaService } from '@mwashburn160/api-core';
import { createApp, runServer, createProtectedRoute, createAuthenticatedWithOrgRoute, attachRequestContext } from '@mwashburn160/api-server';

import { createBulkPipelineRoutes } from './routes/bulk-pipeline';
import { createCreatePipelineRoutes } from './routes/create-pipeline';
import { createDeletePipelineRoutes } from './routes/delete-pipeline';
import { createGeneratePipelineRoutes } from './routes/generate-pipeline';
import { createReadPipelineRoutes } from './routes/read-pipelines';
import { createUpdatePipelineRoutes } from './routes/update-pipeline';

const logger = createLogger('pipeline');
const quotaService = createQuotaService();
const { app, sseManager } = createApp();

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- Create route FIRST — manages its own middleware (uses 'pipelines' quota).
//    Must be before read routes so POST /pipelines doesn't run through the
//    read routes' apiCalls quota check unnecessarily.
app.use('/pipelines', createCreatePipelineRoutes(quotaService));

// -- AI generation routes — auth + orgId (no quota charge) -------------------
app.use('/pipelines', createGeneratePipelineRoutes());

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/pipelines', ...createProtectedRoute(quotaService, 'apiCalls'), createReadPipelineRoutes(quotaService));

// -- Update route — auth + orgId (no quota check) ----------------------------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), createUpdatePipelineRoutes());

// -- Delete route — auth + orgId (admin-only, enforced in handler) -----------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), createDeletePipelineRoutes());

// -- Bulk routes — auth + orgId (no quota check) ----------------------------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), createBulkPipelineRoutes());

logger.info('All /pipelines routes registered');

void runServer(app, { name: 'Pipeline Service', sseManager });
