import { createLogger, createQuotaService } from '@mwashburn160/api-core';
import {
  createApp,
  runServer,
  attachRequestContext,
  createProtectedRoute,
  createAuthenticatedWithOrgRoute,
} from '@mwashburn160/api-server';
import { createReadRuleRoutes } from './routes/read-rules';
import { createCreateRuleRoutes } from './routes/create-rules';
import { createUpdateRuleRoutes } from './routes/update-rules';
import { createDeleteRuleRoutes } from './routes/delete-rules';
import { createValidateRoutes } from './routes/validate';

const logger = createLogger('compliance');
const quotaService = createQuotaService();
const { app, sseManager } = createApp();

// Attach request context to all requests
app.use(attachRequestContext(sseManager));

// Validation endpoints (auth + org, rate limited) — before CRUD to avoid /:id catch
app.use('/compliance/validate', ...createAuthenticatedWithOrgRoute(), createValidateRoutes());

// Rule CRUD routes
app.use('/compliance/rules', ...createProtectedRoute(quotaService, 'apiCalls'), createReadRuleRoutes());
app.use('/compliance/rules', ...createAuthenticatedWithOrgRoute(), createCreateRuleRoutes());
app.use('/compliance/rules', ...createAuthenticatedWithOrgRoute(), createUpdateRuleRoutes());
app.use('/compliance/rules', ...createAuthenticatedWithOrgRoute(), createDeleteRuleRoutes());

logger.info('All /compliance routes registered');

void runServer(app, {
  name: 'Compliance Service',
  sseManager,
});

export { app };
