// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, requireAuth, requirePermission, wireServiceSecurity } from '@pipeline-builder/api-core';
import {
  createApp,
  runServer,
  attachRequestContext,
  createProtectedRoute,
  createAuthenticatedWithOrgRoute,
  meterQuotaOnSuccess,
  postgresHealthCheck,
} from '@pipeline-builder/api-server';
import { createSoftDeletePurgeScheduler } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { startAuditPruneCron } from './helpers/compliance-check-log.js';
import { startDigestScheduler, stopDigestScheduler } from './helpers/digest-scheduler.js';
import { startScanScheduler, stopScanScheduler } from './helpers/scan-scheduler.js';
import { createAuditRoutes } from './routes/audit.js';
import { createCreatePolicyRoutes } from './routes/create-policies.js';
import { createCreateRuleRoutes } from './routes/create-rules.js';
import { createDeletePolicyRoutes } from './routes/delete-policies.js';
import { createDeleteRuleRoutes } from './routes/delete-rules.js';
import { createEntitlementSyncRoutes } from './routes/entitlements.js';
import { createEntityEventRoutes } from './routes/entity-events.js';
import { createExemptionRoutes } from './routes/exemptions.js';
import { createNotificationPreferenceRoutes } from './routes/notification-preferences.js';
import { createReadPolicyRoutes } from './routes/read-policies.js';
import { createReadRuleRoutes } from './routes/read-rules.js';
import { createPurgePolicyRoutes } from './routes/purge-policies.js';
import { createPurgeRuleRoutes } from './routes/purge-rules.js';
import { createRestorePolicyRoutes } from './routes/restore-policies.js';
import { createRestoreRuleRoutes } from './routes/restore-rules.js';
import { createScanScheduleRoutes } from './routes/scan-schedules.js';
import { createScanRoutes } from './routes/scans.js';
import { createPublishedRulesCatalogRoutes, createSubscriptionRoutes } from './routes/subscriptions.js';
import { createTemplateRoutes } from './routes/templates.js';
import { createUpdatePolicyRoutes } from './routes/update-policies.js';
import { createUpdateRuleRoutes } from './routes/update-rules.js';
import { createValidateRoutes } from './routes/validate.js';
import { complianceRuleService } from './services/compliance-rule-service.js';
import { compliancePolicyService } from './services/policy-service.js';
import { getAuditClient } from './services/remote-audit-client.js';

const logger = createLogger('compliance');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({
  // Compliance's hard dependency is postgres. Redis is only used fail-open now
  // (token-revocation reader + scheduler leader locks via the shared env-Redis
  // client), so it must NOT gate readiness — a Redis outage degrades gracefully
  // rather than pulling the service out of the load balancer.
  checkDependencies: postgresHealthCheck,
});

// Attach request context to all requests
app.use(attachRequestContext(sseManager));

// Meter apiCalls quota for every successful, user-driven /compliance request.
// `createProtectedRoute` below only CHECKS the apiCalls quota; without this the
// counter is never incremented, so compliance traffic went entirely unmetered
// (and the auth-only route groups — validate/subscriptions/scans/schedules/
// templates — were neither checked nor metered). One finish-based mount closes
// the loop for ALL /compliance routes: it skips non-2xx, unauthenticated, and
// service-principal (internal S2S) requests. Registered BEFORE the routers so
// its `finish` listener is attached for each request. Fire-and-forget.
app.use('/compliance', meterQuotaOnSuccess(quotaService, 'apiCalls'));

// Validation endpoints (auth + org, rate limited) — before CRUD to avoid /:id catch
app.use('/compliance/validate', ...createAuthenticatedWithOrgRoute(), createValidateRoutes());

// Rule CRUD routes — all mutations and reads run through quota middleware.
// Mutations additionally require an org admin/owner: compliance rules are
// org-governance config, so a regular member must not create/change/delete them.
// ONE protected layer per resource. Read routes go first (they terminate GETs);
// then a single write-permission gate; then the mutation routers. Previously each
// verb was a SEPARATE `createProtectedRoute()` layer on the same prefix, so a write
// request re-ran the protected chain — the read layer reserved the Idempotency-Key
// as `pending`, then the write layer saw `pending` and 409'd before the handler ran
// (keyed rule/policy writes never executed; auth/quota also ran twice). Combining
// into one router runs the protected chain exactly once.
const rulesRouter = Router();
rulesRouter.use(createReadRuleRoutes());
rulesRouter.use(requirePermission('compliance:write'));
rulesRouter.use(createCreateRuleRoutes());
rulesRouter.use(createUpdateRuleRoutes());
rulesRouter.use(createDeleteRuleRoutes());
// Restore (POST /:id/restore) sits after the write-permission gate; the route
// adds requireStepUp itself (the composite chain has no step-up).
rulesRouter.use(createRestoreRuleRoutes());
// Purge (POST /:id/purge) — permanent hard-delete of an already-soft-deleted
// tombstone. Same write-permission gate; the route adds requireStepUp itself
// (like restore) since purge is an irreversible destructive action.
rulesRouter.use(createPurgeRuleRoutes());
app.use('/compliance/rules', ...createProtectedRoute(quotaService, 'apiCalls'), rulesRouter);

// Published rules catalog (auth + org, rate limited)
app.use('/compliance/published-rules', ...createProtectedRoute(quotaService, 'apiCalls'), createPublishedRulesCatalogRoutes());

// Subscription management (auth + org)
app.use('/compliance/subscriptions', ...createAuthenticatedWithOrgRoute(), createSubscriptionRoutes());

// Audit log (auth + org, rate limited)
app.use('/compliance/audit', ...createProtectedRoute(quotaService, 'apiCalls'), createAuditRoutes());

// Exemption management (auth + org)
app.use('/compliance/exemptions', ...createProtectedRoute(quotaService, 'apiCalls'), createExemptionRoutes());

// Notification preferences (auth + org; PUT is gated to admins inside the router)
app.use('/compliance/notification-preferences', ...createAuthenticatedWithOrgRoute(), createNotificationPreferenceRoutes());

// Compliance scans (auth + org)
app.use('/compliance/scans', ...createAuthenticatedWithOrgRoute(), createScanRoutes());

// Scan schedules (auth + org)
app.use('/compliance/scan-schedules', ...createAuthenticatedWithOrgRoute(), createScanScheduleRoutes());

// Policy CRUD routes — mutations require an org admin/owner (governance config),
// reads are open to any authenticated org member. Single router (see rules above):
// one protected chain, read-first, then the write-permission gate + mutations. This
// also brings policy writes under the same `apiCalls` quota + idempotency the reads
// use (previously policy writes ran on the un-metered auth-only chain).
const policiesRouter = Router();
policiesRouter.use(createReadPolicyRoutes());
policiesRouter.use(requirePermission('compliance:write'));
policiesRouter.use(createCreatePolicyRoutes());
policiesRouter.use(createUpdatePolicyRoutes());
policiesRouter.use(createDeletePolicyRoutes());
policiesRouter.use(createRestorePolicyRoutes());
// Purge (POST /:id/purge) — permanent hard-delete of a soft-deleted policy
// tombstone. Write-permission gated; the route adds requireStepUp (see rules
// purge above).
policiesRouter.use(createPurgePolicyRoutes());
app.use('/compliance/policies', ...createProtectedRoute(quotaService, 'apiCalls'), policiesRouter);

// Rule templates (auth + org)
app.use('/compliance/templates', ...createAuthenticatedWithOrgRoute(), createTemplateRoutes());

// Internal entity event receiver. The route itself runs `requireAuth` +
// `requireServicePrincipal`, so peer services must mint a JWT via
// `getServiceAuthHeader` (a plain HTTP header is no longer sufficient).
app.use('/compliance/events/entity', createEntityEventRoutes());

// Internal billing → compliance entitlement sync (curated content sets). Bare
// `requireAuth` prefix (like reporting's /reports/retention-sync); the route
// itself enforces service-principal-or-sysadmin, so requireAuth doesn't
// double-run and no org-user permission/feature gate applies. Resolves to
// `/api/compliance/entitlements/:orgId` behind the gateway.
app.use('/compliance/entitlements', requireAuth, createEntitlementSyncRoutes());

logger.info('All /compliance routes registered');

// Forward denied state-changing authorizations (rejected by requirePermission /
// requireSystemAdmin) into the same remote audit sink as the mutation events,
// as best-effort `authz.denied` failure records. Registered once at boot.
// Token-revocation reader (session-invalidation option b): the env-Redis store
// is lazily built + fully fail-open, so `requireAuth` can reject a token whose
// `tokenVersion` is behind the platform-published version, degrading to natural
// token expiry (never a lockout) when Redis is absent.
wireServiceSecurity('compliance', getAuditClient);

// Daily prune of compliance_audit_log (default 180 days, override via
// COMPLIANCE_AUDIT_RETENTION_DAYS). The handle is captured for graceful
// shutdown so tests/process-exit don't leave a dangling timer.
const auditPrune = startAuditPruneCron();

// Retention purge: hard-delete compliance policy + rule tombstones past their
// purge_after deadline. Leader-locked + sysadmin-scoped inside the sweep. Opt
// out with SOFT_DELETE_PURGE_ENABLED=false.
const purgeScheduler = createSoftDeletePurgeScheduler({
  service: 'compliance',
  entities: [
    { name: 'compliance_policy', purgeExpired: (now, limit) => compliancePolicyService.purgeExpired(now, limit) },
    { name: 'compliance_rule', purgeExpired: (now, limit) => complianceRuleService.purgeExpired(now, limit) },
  ],
});

void runServer(app, {
  name: 'Compliance Service',
  sseManager,
  onShutdown: async () => {
    stopScanScheduler();
    stopDigestScheduler();
    auditPrune.stop();
    purgeScheduler?.stop();
  },
});

startScanScheduler();
startDigestScheduler();
purgeScheduler?.start();

export { app };
