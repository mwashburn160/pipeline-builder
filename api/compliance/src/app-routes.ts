// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireAuth, type QuotaService } from '@pipeline-builder/api-core';
import {
  createProtectedRoute,
  createAuthenticatedWithOrgRoute,
  meterQuotaOnSuccess,
} from '@pipeline-builder/api-server';
import { Router, type Express } from 'express';

import { createAuditRoutes } from './routes/audit.js';
import { createCreatePolicyRoutes } from './routes/create-policies.js';
import { createCreateRuleRoutes } from './routes/create-rules.js';
import { createDeletePolicyRoutes } from './routes/delete-policies.js';
import { createDeleteRuleRoutes } from './routes/delete-rules.js';
import { createEntitlementSyncRoutes } from './routes/entitlements.js';
import { createEntityEventRoutes } from './routes/entity-events.js';
import { createExemptionRoutes } from './routes/exemptions.js';
import { createNotificationPreferenceRoutes } from './routes/notification-preferences.js';
import { createPurgePolicyRoutes } from './routes/purge-policies.js';
import { createPurgeRuleRoutes } from './routes/purge-rules.js';
import { createReadPolicyRoutes } from './routes/read-policies.js';
import { createReadRuleRoutes } from './routes/read-rules.js';
import { createRestorePolicyRoutes } from './routes/restore-policies.js';
import { createRestoreRuleRoutes } from './routes/restore-rules.js';
import { createScanScheduleRoutes } from './routes/scan-schedules.js';
import { createScanRoutes } from './routes/scans.js';
import { createPublishedRulesCatalogRoutes, createSubscriptionRoutes } from './routes/subscriptions.js';
import { createTemplateRoutes } from './routes/templates.js';
import { createUpdatePolicyRoutes } from './routes/update-policies.js';
import { createUpdateRuleRoutes } from './routes/update-rules.js';
import { createValidateRoutes } from './routes/validate.js';

/** Dependencies the route factories need. */
export interface ComplianceRouteDeps {
  quotaService: QuotaService;
}

/**
 * Mount every compliance-service route on `app`. Shared by `index.ts` (the
 * running service) and the route-coverage test, so the route table the test
 * checks is the one production serves. Mount ORDER is load-bearing (see the
 * per-mount comments).
 */
export function mountRoutes(app: Express, { quotaService }: ComplianceRouteDeps): void {
  // Meter apiCalls quota for every successful, user-driven /compliance request.
  // `createProtectedRoute` below only CHECKS the apiCalls quota; without this the
  // counter is never incremented, so compliance traffic went entirely unmetered
  // (and the auth-only route groups — validate/subscriptions/scans/schedules/
  // templates — were neither checked nor metered). One finish-based mount closes
  // the loop for ALL /compliance routes: it skips non-2xx, unauthenticated, and
  // service-principal (internal S2S) requests. Registered BEFORE the routers so
  // its `finish` listener is attached for each request. Fire-and-forget.
  app.use('/compliance', meterQuotaOnSuccess(quotaService, 'apiCalls'));

  // Validation endpoints (auth + org, rate limited) — before CRUD to avoid /:id
  // catch. Each route carries `requirePermissionOrService('compliance:read')`.
  app.use('/compliance/validate', ...createAuthenticatedWithOrgRoute(), createValidateRoutes());

  // Rule CRUD routes — all mutations and reads run through quota middleware.
  // Mutations additionally require an org admin/owner: compliance rules are
  // org-governance config, so a regular member must not create/change/delete them.
  // ONE protected layer per resource; every gate is PER ROUTE inside the routers
  // (reads: `compliance:read`; mutations: `compliance:write`, plus `requireStepUp`
  // on restore/purge). No router-level `use(requirePermission(...))`: it would run
  // for every request reaching the prefix, depending on mount order to stay off
  // the reads, and make the route table read as if the mutations were ungated.
  // One router (not a `createProtectedRoute()` layer per verb) so the protected
  // chain runs exactly once — a second layer would see the Idempotency-Key the
  // first reserved as `pending` and 409 before the handler ran.
  const rulesRouter = Router();
  rulesRouter.use(createReadRuleRoutes());
  rulesRouter.use(createCreateRuleRoutes());
  rulesRouter.use(createUpdateRuleRoutes());
  rulesRouter.use(createDeleteRuleRoutes());
  // Restore (POST /:id/restore) — the route carries compliance:write + requireStepUp.
  rulesRouter.use(createRestoreRuleRoutes());
  // Purge (POST /:id/purge) — permanent hard-delete of an already-soft-deleted
  // tombstone; same compliance:write + requireStepUp chain on the route, since
  // purge is an irreversible destructive action.
  rulesRouter.use(createPurgeRuleRoutes());
  app.use('/compliance/rules', ...createProtectedRoute(quotaService, 'apiCalls'), rulesRouter);

  // Published rules catalog (auth + org, rate limited; compliance:read per route)
  app.use('/compliance/published-rules', ...createProtectedRoute(quotaService, 'apiCalls'), createPublishedRulesCatalogRoutes());

  // Subscription management (auth + org). Per-route gates: compliance:read for
  // the opt-in half, compliance:write for deactivate/unsubscribe/clone/pin.
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
  // reads are open to any org member holding `compliance:read`. Single router (see
  // rules above): one protected chain, per-route gates inside the routers. This
  // also keeps policy writes under the same `apiCalls` quota + idempotency the
  // reads use.
  const policiesRouter = Router();
  policiesRouter.use(createReadPolicyRoutes());
  policiesRouter.use(createCreatePolicyRoutes());
  policiesRouter.use(createUpdatePolicyRoutes());
  policiesRouter.use(createDeletePolicyRoutes());
  policiesRouter.use(createRestorePolicyRoutes());
  // Purge (POST /:id/purge) — permanent hard-delete of a soft-deleted policy
  // tombstone; compliance:write + requireStepUp on the route (see rules purge).
  policiesRouter.use(createPurgePolicyRoutes());
  app.use('/compliance/policies', ...createProtectedRoute(quotaService, 'apiCalls'), policiesRouter);

  // Rule templates (auth + org)
  app.use('/compliance/templates', ...createAuthenticatedWithOrgRoute(), createTemplateRoutes());

  // Internal entity event receiver. The route itself runs `requireAuth` +
  // `requireInternalService({ callers: ['pipeline', 'plugin'] })`, so only those
  // two services' own signed tokens reach it — no user token, and no other
  // service.
  app.use('/compliance/events/entity', createEntityEventRoutes());

  // Internal billing → compliance entitlement sync (curated content sets). Bare
  // `requireAuth` prefix (like reporting's /reports/retention-sync); the route
  // itself enforces `requireInternalService({ callers: ['billing'] })`, so
  // requireAuth doesn't double-run and no org-user permission/feature gate
  // applies. Resolves to `/api/compliance/entitlements/:orgId` behind the
  // gateway.
  app.use('/compliance/entitlements', requireAuth, createEntitlementSyncRoutes());
}
