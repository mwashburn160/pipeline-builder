import { createLogger, createQuotaService, registerComplianceEventSubscriber, requireFeature } from '@mwashburn160/api-core';
import { createApp, runServer, createProtectedRoute, createAuthenticatedWithOrgRoute, attachRequestContext } from '@mwashburn160/api-server';
import { db } from '@mwashburn160/pipeline-core';
import { sql } from 'drizzle-orm';

import { createBulkPipelineRoutes } from './routes/bulk-pipeline';
import { createCreatePipelineRoutes } from './routes/create-pipeline';
import { createDeletePipelineRoutes } from './routes/delete-pipeline';
import { createGeneratePipelineRoutes } from './routes/generate-pipeline';
import { createReadPipelineRoutes } from './routes/read-pipelines';
import { createRegistryRoutes } from './routes/registry';
import { createUpdatePipelineRoutes } from './routes/update-pipeline';

const logger = createLogger('pipeline');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({
  checkDependencies: async () => {
    try { await db.execute(sql`SELECT 1`); return { postgres: 'connected' as const }; }
    catch { return { postgres: 'unknown' as const }; }
  },
});

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- Create route FIRST — manages its own middleware (uses 'pipelines' quota).
//    Must be before read routes so POST /pipelines doesn't run through the
//    read routes' apiCalls quota check unnecessarily.
app.use('/pipelines', createCreatePipelineRoutes(quotaService));

// -- AI generation routes — auth + orgId + ai_generation feature gate --------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), requireFeature('ai_generation'), createGeneratePipelineRoutes());

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/pipelines', ...createProtectedRoute(quotaService, 'apiCalls'), createReadPipelineRoutes(quotaService));

// -- Update route — auth + orgId (no quota check) ----------------------------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), createUpdatePipelineRoutes());

// -- Delete route — auth + orgId (admin-only, enforced in handler) -----------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), createDeletePipelineRoutes());

// -- Bulk routes — auth + orgId + bulk_operations feature gate ---------------
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), requireFeature('bulk_operations'), createBulkPipelineRoutes());

// -- Registry route — auth + orgId (upsert pipeline ARN for event reporting) -
app.use('/pipelines', ...createAuthenticatedWithOrgRoute(), createRegistryRoutes());

// -- Register compliance event subscriber for entity lifecycle events --------
registerComplianceEventSubscriber();

logger.info('All /pipelines routes registered');

void runServer(app, { name: 'Pipeline Service', sseManager });
