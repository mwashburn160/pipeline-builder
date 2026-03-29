import { createLogger, createQuotaService, createHealthRouter, registerComplianceQueueBackend } from '@mwashburn160/api-core';
import { enqueue, startComplianceWorker, stopComplianceWorker } from './queue/compliance-event-queue';
import { evaluateEntityEvent } from './helpers/entity-event-handler';
import {
  createApp,
  runServer,
  attachRequestContext,
  createProtectedRoute,
  createAuthenticatedWithOrgRoute,
} from '@mwashburn160/api-server';
import { db } from '@mwashburn160/pipeline-core';
import { sql } from 'drizzle-orm';
import { startScanScheduler, stopScanScheduler } from './helpers/scan-scheduler';
import { createAuditRoutes } from './routes/audit';
import { createCreatePolicyRoutes } from './routes/create-policies';
import { createCreateRuleRoutes } from './routes/create-rules';
import { createDeletePolicyRoutes } from './routes/delete-policies';
import { createDeleteRuleRoutes } from './routes/delete-rules';
import { createEntityEventRoutes } from './routes/entity-events';
import { createExemptionRoutes } from './routes/exemptions';
import { createReadPolicyRoutes } from './routes/read-policies';
import { createReadRuleRoutes } from './routes/read-rules';
import { createScanScheduleRoutes } from './routes/scan-schedules';
import { createScanRoutes } from './routes/scans';
import { createPublishedRulesCatalogRoutes, createSubscriptionRoutes } from './routes/subscriptions';
import { createTemplateRoutes } from './routes/templates';
import { createUpdatePolicyRoutes } from './routes/update-policies';
import { createUpdateRuleRoutes } from './routes/update-rules';
import { createValidateRoutes } from './routes/validate';

const logger = createLogger('compliance');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({ skipDefaultHealthCheck: true });

// Attach request context to all requests
app.use(attachRequestContext(sseManager));

// -- Health check with dependency monitoring ----------------------------------
app.use(createHealthRouter({
  serviceName: 'compliance',
  checkDependencies: async () => {
    try { await db.execute(sql`SELECT 1`); return { postgres: 'connected' as const }; }
    catch { return { postgres: 'disconnected' as const }; }
  },
}));

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

// Scan schedules (auth + org)
app.use('/compliance/scan-schedules', ...createAuthenticatedWithOrgRoute(), createScanScheduleRoutes());

// Policy CRUD routes
app.use('/compliance/policies', ...createProtectedRoute(quotaService, 'apiCalls'), createReadPolicyRoutes());
app.use('/compliance/policies', ...createAuthenticatedWithOrgRoute(), createCreatePolicyRoutes());
app.use('/compliance/policies', ...createAuthenticatedWithOrgRoute(), createUpdatePolicyRoutes());
app.use('/compliance/policies', ...createAuthenticatedWithOrgRoute(), createDeletePolicyRoutes());

// Rule templates (auth + org)
app.use('/compliance/templates', ...createAuthenticatedWithOrgRoute(), createTemplateRoutes());

// Internal entity event receiver (service-to-service, no user auth)
app.use('/compliance/events/entity', createEntityEventRoutes());

logger.info('All /compliance routes registered');

// Register BullMQ as the compliance event queue backend (used by plugin/pipeline services)
registerComplianceQueueBackend(enqueue);

// Start the compliance event worker (processes async re-validation events)
startComplianceWorker(async (event) => {
  await evaluateEntityEvent({
    entityId: event.entityId,
    orgId: event.orgId,
    target: event.target,
    eventType: event.eventType,
    userId: event.userId,
    attributes: event.attributes,
  });
});

void runServer(app, {
  name: 'Compliance Service',
  sseManager,
  onShutdown: async () => {
    stopScanScheduler();
    await stopComplianceWorker();
  },
});

startScanScheduler();

export { app };
