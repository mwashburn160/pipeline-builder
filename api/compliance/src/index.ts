import { createLogger, createQuotaService } from '@mwashburn160/api-core';
import {
  createApp,
  runServer,
  attachRequestContext,
  createProtectedRoute,
  createAuthenticatedWithOrgRoute,
} from '@mwashburn160/api-server';
import { createAuditRoutes } from './routes/audit';
import { createCreateRuleRoutes } from './routes/create-rules';
import { createDeleteRuleRoutes } from './routes/delete-rules';
import { createExemptionRoutes } from './routes/exemptions';
import { createReadRuleRoutes } from './routes/read-rules';
import { createScanRoutes } from './routes/scans';
import { createPublishedRulesCatalogRoutes, createSubscriptionRoutes } from './routes/subscriptions';
import { createTemplateRoutes } from './routes/templates';
import { createUpdateRuleRoutes } from './routes/update-rules';
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

// Published rules catalog (auth + org, rate limited)
app.use('/compliance/published-rules', ...createProtectedRoute(quotaService, 'apiCalls'), createPublishedRulesCatalogRoutes());

// Subscription management (auth + org)
app.use('/compliance/subscriptions', ...createAuthenticatedWithOrgRoute(), createSubscriptionRoutes());

// Audit log (auth + org, rate limited)
app.use('/compliance/audit', ...createProtectedRoute(quotaService, 'apiCalls'), createAuditRoutes());

// Exemption management (auth + org)
app.use('/compliance/exemptions', ...createAuthenticatedWithOrgRoute(), createExemptionRoutes());

// Compliance scans (auth + org)
app.use('/compliance/scans', ...createAuthenticatedWithOrgRoute(), createScanRoutes());

// Rule templates (auth + org)
app.use('/compliance/templates', ...createAuthenticatedWithOrgRoute(), createTemplateRoutes());

logger.info('All /compliance routes registered');

void runServer(app, {
  name: 'Compliance Service',
  sseManager,
});

export { app };
