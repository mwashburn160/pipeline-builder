// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, registerComplianceQueueBackend, requirePermission } from '@pipeline-builder/api-core';
import {
  createApp,
  runServer,
  attachRequestContext,
  createProtectedRoute,
  createAuthenticatedWithOrgRoute,
  postgresHealthCheck,
  redisHealthCheck,
  combineHealthChecks,
} from '@pipeline-builder/api-server';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { startAuditPruneCron } from './helpers/audit-logger.js';
import { startDigestScheduler, stopDigestScheduler } from './helpers/digest-scheduler.js';
import { evaluateEntityEvent } from './helpers/entity-event-handler.js';
import { startScanScheduler, stopScanScheduler } from './helpers/scan-scheduler.js';
import { enqueue, startComplianceWorker, stopComplianceWorker, getQueueRedis } from './queue/compliance-event-queue.js';
import { createAuditRoutes } from './routes/audit.js';
import { createCreatePolicyRoutes } from './routes/create-policies.js';
import { createCreateRuleRoutes } from './routes/create-rules.js';
import { createDeletePolicyRoutes } from './routes/delete-policies.js';
import { createDeleteRuleRoutes } from './routes/delete-rules.js';
import { createEntityEventRoutes } from './routes/entity-events.js';
import { createExemptionRoutes } from './routes/exemptions.js';
import { createNotificationPreferenceRoutes } from './routes/notification-preferences.js';
import { createReadPolicyRoutes } from './routes/read-policies.js';
import { createReadRuleRoutes } from './routes/read-rules.js';
import { createScanScheduleRoutes } from './routes/scan-schedules.js';
import { createScanRoutes } from './routes/scans.js';
import { createPublishedRulesCatalogRoutes, createSubscriptionRoutes } from './routes/subscriptions.js';
import { createTemplateRoutes } from './routes/templates.js';
import { createUpdatePolicyRoutes } from './routes/update-policies.js';
import { createUpdateRuleRoutes } from './routes/update-rules.js';
import { createValidateRoutes } from './routes/validate.js';

const logger = createLogger('compliance');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({
  // Compliance depends on BOTH postgres and redis (the BullMQ event queue) —
  // probe each in parallel.
  checkDependencies: combineHealthChecks(
    () => postgresHealthCheck(),
    redisHealthCheck(() => getQueueRedis()),
  ),
});

// Attach request context to all requests
app.use(attachRequestContext(sseManager));

// Validation endpoints (auth + org, rate limited) — before CRUD to avoid /:id catch
app.use('/compliance/validate', ...createAuthenticatedWithOrgRoute(), createValidateRoutes());

// Rule CRUD routes — all mutations and reads run through quota middleware.
// Mutations additionally require an org admin/owner: compliance rules are
// org-governance config, so a regular member must not create/change/delete them.
app.use('/compliance/rules', ...createProtectedRoute(quotaService, 'apiCalls'), createReadRuleRoutes());
app.use('/compliance/rules', ...createProtectedRoute(quotaService, 'apiCalls'), requirePermission('compliance:write'), createCreateRuleRoutes());
app.use('/compliance/rules', ...createProtectedRoute(quotaService, 'apiCalls'), requirePermission('compliance:write'), createUpdateRuleRoutes());
app.use('/compliance/rules', ...createProtectedRoute(quotaService, 'apiCalls'), requirePermission('compliance:write'), createDeleteRuleRoutes());

// Published rules catalog (auth + org, rate limited)
app.use('/compliance/published-rules', ...createProtectedRoute(quotaService, 'apiCalls'), createPublishedRulesCatalogRoutes());

// Subscription management (auth + org)
app.use('/compliance/subscriptions', ...createAuthenticatedWithOrgRoute(), createSubscriptionRoutes());

// Audit log (auth + org, rate limited)
app.use('/compliance/audit', ...createProtectedRoute(quotaService, 'apiCalls'), createAuditRoutes());

// Exemption management (auth + org)
app.use('/compliance/exemptions', ...createAuthenticatedWithOrgRoute(), createExemptionRoutes());

// Notification preferences (auth + org; PUT is gated to admins inside the router)
app.use('/compliance/notification-preferences', ...createAuthenticatedWithOrgRoute(), createNotificationPreferenceRoutes());

// Compliance scans (auth + org)
app.use('/compliance/scans', ...createAuthenticatedWithOrgRoute(), createScanRoutes());

// Scan schedules (auth + org)
app.use('/compliance/scan-schedules', ...createAuthenticatedWithOrgRoute(), createScanScheduleRoutes());

// Policy CRUD routes — mutations require an org admin/owner (governance config),
// reads are open to any authenticated org member.
app.use('/compliance/policies', ...createProtectedRoute(quotaService, 'apiCalls'), createReadPolicyRoutes());
app.use('/compliance/policies', ...createAuthenticatedWithOrgRoute(), requirePermission('compliance:write'), createCreatePolicyRoutes());
app.use('/compliance/policies', ...createAuthenticatedWithOrgRoute(), requirePermission('compliance:write'), createUpdatePolicyRoutes());
app.use('/compliance/policies', ...createAuthenticatedWithOrgRoute(), requirePermission('compliance:write'), createDeletePolicyRoutes());

// Rule templates (auth + org)
app.use('/compliance/templates', ...createAuthenticatedWithOrgRoute(), createTemplateRoutes());

// Internal entity event receiver. The route itself runs `requireAuth` +
// `requireServicePrincipal`, so peer services must mint a JWT via
// `getServiceAuthHeader` (a plain HTTP header is no longer sufficient).
app.use('/compliance/events/entity', createEntityEventRoutes());

logger.info('All /compliance routes registered');

// Register BullMQ as the compliance event queue backend (used by plugin/pipeline services)
registerComplianceQueueBackend(enqueue);

// Start the compliance event worker (processes async re-validation events).
// Each job carries its own orgId; establish the tenant scope per-job so any
// `withTenantTx` inside `evaluateEntityEvent` runs with the right RLS GUCs.
// Without this wrap the worker would silently hit FORCE'd tables with an
// empty org_id and either get zero rows or "permission denied."
startComplianceWorker(async (event) => {
  const result = await runWithTenantContext({ orgId: event.orgId, isSuperAdmin: false }, () =>
    evaluateEntityEvent({
      entityId: event.entityId,
      orgId: event.orgId,
      parentOrgId: event.parentOrgId,
      target: event.target,
      eventType: event.eventType,
      userId: event.userId,
      attributes: event.attributes,
    }),
  );
  // `evaluateEntityEvent` returns `{ error: true }` (rather than throwing) on an
  // evaluation failure so the HTTP path can reply 500. The BullMQ worker must
  // THROW on that flag, else the job resolves "completed" and never retries —
  // fail-open, letting a non-compliant entity slip through on the async path.
  if (result.error) {
    throw new Error(`Compliance evaluation failed for ${event.target} ${event.entityId}; retrying`);
  }
});

// Daily prune of compliance_audit_log (default 180 days, override via
// COMPLIANCE_AUDIT_RETENTION_DAYS). The handle is captured for graceful
// shutdown so tests/process-exit don't leave a dangling timer.
const auditPrune = startAuditPruneCron();

void runServer(app, {
  name: 'Compliance Service',
  sseManager,
  onShutdown: async () => {
    stopScanScheduler();
    stopDigestScheduler();
    auditPrune.stop();
    await stopComplianceWorker();
  },
});

startScanScheduler();
startDigestScheduler();

export { app };
