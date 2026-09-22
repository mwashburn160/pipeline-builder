// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * API route mounting, factored out of `index.ts`.
 *
 * `index.ts` still owns the surrounding middleware (helmet, cors, body parsing,
 * mongo sanitization, health/readiness, tenant context, metrics, the general
 * rate limiter, the impersonation read-only gate and the error handlers) and the
 * limiters themselves; this module owns ONLY the `app.use(...)` route
 * registrations, so the route table the coverage test builds
 * (`test/route-coverage.test.ts`) is the one production serves.
 *
 * Mount ORDER is load-bearing (the alert-webhook limiter must precede the
 * tenant-facing `/observability` mount so the two never share a budget) — keep
 * it as-is.
 */

import type { Express, RequestHandler } from 'express';

import {
  authRoutes, deviceAuthRoutes, oauthRoutes, ssoRoutes, userRoutes, usersRoutes, organizationRoutes, organizationsRoutes,
  invitationRoutes, auditRoutes, notifyEmailRoutes, configRoutes, observabilityRoutes, dashboardRoutes,
  orgIdpRoutes, orgKmsConfigRoutes, orgNamespaceRoutes, userGrantsRoutes, adminConsoleRoutes, adminSummaryRoutes, impersonateRoutes,
  scimRoutes, mfaResetAdminRoutes, ecosystemInternalRoutes,
} from './index.js';

/**
 * The Alertmanager relay webhook path. Machine-to-machine and unauthenticated at
 * middleware time (it checks a per-instance bearer inside the handler), so it
 * gets its own generous limiter rather than the user-sized buckets — see
 * `isAlertWebhook` in `index.ts`.
 */
export const ALERT_WEBHOOK_PATH = '/observability/alert-webhook';

/** Where an identity provider's SCIM client connects. Declared next to the
 *  mount that uses it, like the alert webhook, because `index.ts` also needs it
 *  to keep the general limiter off this surface. */
export const SCIM_PATH = '/scim/v2';

/** The per-surface limiters `index.ts` builds and this module mounts. */
export interface RouteLimiters {
  /** Strict IP-keyed limiter for the pre-auth `/auth*` surface. */
  auth: RequestHandler;
  /** Dedicated burst bucket for the Alertmanager relay. */
  alertWebhook: RequestHandler;
  /** Tighter per-org limiter for the Prometheus/Loki-backed reads. */
  observability: RequestHandler;
  /** Per-ORG bucket for the SCIM surface (a directory sync is bursty and must
   *  not spend the org's interactive API budget). */
  scim: RequestHandler;
}

/**
 * Mount every platform API route on `app`.
 *
 * Note: nginx strips the `/api` prefix before proxying to this service.
 */
export function mountApiRoutes(app: Express, limiters: RouteLimiters): void {
  // Device authorization first: a conforming client polls every 5 seconds for up
  // to 10 minutes, which would exhaust the strict pre-auth `auth` bucket (20 per
  // 15 min per IP) in the first two minutes. The router carries its own per-code
  // and per-IP limiters, so this mount must SHADOW the `/auth` one below.
  app.use('/auth/device', deviceAuthRoutes);
  app.use('/auth', limiters.auth, authRoutes);
  app.use('/auth/oauth', limiters.auth, oauthRoutes);
  app.use('/auth/sso', limiters.auth, ssoRoutes);
  app.use('/user', userRoutes);
  app.use('/users', usersRoutes);
  app.use('/organization', organizationRoutes);
  app.use('/organizations', organizationsRoutes);
  app.use('/invitation', invitationRoutes);
  app.use('/audit', auditRoutes);
  app.use('/internal/notify-email', notifyEmailRoutes);
  app.use('/internal/ecosystem', ecosystemInternalRoutes);
  app.use('/config', configRoutes);
  // The relay's own bucket, mounted ahead of the tenant-facing limiter so the
  // two never share a budget.
  app.use(ALERT_WEBHOOK_PATH, limiters.alertWebhook);
  app.use('/observability', limiters.observability, observabilityRoutes);
  app.use('/dashboards', dashboardRoutes);
  // SCIM gets its OWN per-org bucket, sized for a directory sync — `index.ts`
  // keeps the general limiter off this path so the two never share a budget.
  app.use(SCIM_PATH, limiters.scim, scimRoutes);
  app.use('/admin/org-idp', orgIdpRoutes);
  app.use('/admin/orgs/:orgId/kms-config', orgKmsConfigRoutes);
  app.use('/admin/orgs/:orgId/k8s-namespace.yaml', orgNamespaceRoutes);
  app.use('/admin/users/:id/grants', userGrantsRoutes);
  app.use('/admin/users/:id/mfa-reset', mfaResetAdminRoutes);
  // nginx's auth_request gate for the admin consoles (pgAdmin/mongo-express/
  // Grafana/Kiali) on the AWS targets.
  app.use('/admin/console-check', adminConsoleRoutes);
  app.use('/admin/summary', adminSummaryRoutes);
  app.use('/admin/impersonate', impersonateRoutes);
}
