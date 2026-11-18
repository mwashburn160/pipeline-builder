// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * API route mounting, factored out of `index.ts`.
 *
 * `index.ts` still owns the surrounding middleware (helmet, cors, body parsing,
 * mongo sanitization, health/readiness, tenant context, metrics, the general
 * rate limiter, the impersonation read-only gate and the error handlers), and
 * the buckets themselves live in `middleware/limiters.ts`; this module owns
 * ONLY the `app.use(...)` route registrations, so the route table the coverage
 * test builds (`test/route-coverage.test.ts`) is the one production serves.
 *
 * (The `/observability` and `/dashboards` surfaces — and the Alertmanager relay
 * under them — moved to ops-center; nginx routes those prefixes there.)
 */

import type { Express, RequestHandler } from 'express';

import {
  authRoutes, deviceAuthRoutes, oauthRoutes, ssoRoutes, userRoutes, usersRoutes, organizationRoutes, organizationsRoutes,
  invitationRoutes, auditRoutes, notifyEmailRoutes, configRoutes,
  orgIdpRoutes, orgKmsConfigRoutes, orgNamespaceRoutes, userGrantsRoutes, adminConsoleRoutes, adminConsoleSessionRouter, adminSummaryRoutes, impersonateRoutes,
  scimRoutes, mfaResetAdminRoutes, ecosystemInternalRoutes, reportingInternalRoutes, aiInternalRoutes, supportInternalRoutes,
  offersInternalRoutes,
  NOTIFY_EMAIL_MOUNT, ECOSYSTEM_INTERNAL_MOUNT, REPORTING_INTERNAL_MOUNT, AI_INTERNAL_MOUNT, SUPPORT_INTERNAL_MOUNT,
  OFFERS_INTERNAL_MOUNT, opsInternalRoutes, OPS_INTERNAL_MOUNT,
  supportContactRoutes, cascadeAdminRoutes,
} from './index.js';

import { platformApiCallsQuota as apiCallsQuota } from '../middleware/quota.js';

/** Where an identity provider's SCIM client connects. Declared next to the
 *  mount that uses it, because `middleware/limiters.ts` also needs it to keep
 *  the general limiter off this surface. */
export const SCIM_PATH = '/scim/v2';

/** The per-surface limiters (`middleware/limiters.ts`) this module mounts. */
export interface RouteLimiters {
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
  // The `/auth*` surface carries NO tree-wide limiter: each route names the
  // bucket it spends (middleware/auth-limiters.ts) — failed credentials on the
  // per-IP sign-in bucket, page-load reads on the discovery bucket, factor
  // management per user — and everything else is bounded by the root
  // `generalLimiter`. A tree mount here once counted every request under it
  // (page loads, refreshes, the Security page's own reads) as a sign-in attempt,
  // and counted /auth/oauth and /auth/sso TWICE, because both this prefix and
  // theirs carried it. Don't reintroduce one: `auth-rate-limit-budget.test.ts`
  // measures what a normal sign-in spends.
  //
  // Device authorization has its own per-code and per-IP limiters (a conforming
  // client polls every 5 seconds for up to 10 minutes).
  app.use('/auth/device', deviceAuthRoutes);
  app.use('/auth', authRoutes);
  app.use('/auth/oauth', oauthRoutes);
  app.use('/auth/sso', ssoRoutes);
  // `apiCallsQuota` meters + gates the tenant surface on apiCalls, the check
  // run by each route's requireAuth (see middleware/quota.ts): /user, /users, /organization (incl. the nested
  // support-contacts router below, reached through this same prefix — mounting
  // it there too would bill each call twice), /invitation and /audit. NOT on /auth* (sign-in, MFA, OAuth, SSO),
  // /scim (a directory sync, own bucket), /internal, /config, the system-org
  // /organizations listing or the vendor /admin surface (docs/quotas.md).
  app.use('/user', ...apiCallsQuota, userRoutes);
  app.use('/users', ...apiCallsQuota, usersRoutes);
  app.use('/organization', ...apiCallsQuota, organizationRoutes);
  app.use('/organizations', organizationsRoutes);
  app.use('/invitation', ...apiCallsQuota, invitationRoutes);
  app.use('/audit', ...apiCallsQuota, auditRoutes);
  app.use(NOTIFY_EMAIL_MOUNT, notifyEmailRoutes);
  app.use(ECOSYSTEM_INTERNAL_MOUNT, ecosystemInternalRoutes);
  app.use(REPORTING_INTERNAL_MOUNT, reportingInternalRoutes);
  // The org half of every AI call (switch, configured providers, audited key reads).
  app.use(AI_INTERNAL_MOUNT, aiInternalRoutes);
  // Support entitlement, for the message service only (named-caller gated).
  app.use(SUPPORT_INTERNAL_MOUNT, supportInternalRoutes);
  // The expansion-offers profile's membership reads (billing only).
  app.use(OFFERS_INTERNAL_MOUNT, offersInternalRoutes);
  // Tenant-facing, org-scoped: who in this org may raise and own a support case.
  app.use('/organization/:id/support-contacts', supportContactRoutes);
  app.use('/config', configRoutes);
  // The ops identity facts ops-center reads (account root, audit activity,
  // live org ids) — ops-center only.
  app.use(OPS_INTERNAL_MOUNT, opsInternalRoutes);
  // SCIM gets its OWN per-org bucket, sized for a directory sync — the general
  // limiter skips this path so the two never share a budget.
  app.use(SCIM_PATH, limiters.scim, scimRoutes);
  app.use('/admin/org-idp', orgIdpRoutes);
  app.use('/admin/orgs/:orgId/kms-config', orgKmsConfigRoutes);
  app.use('/admin/orgs/:orgId/k8s-namespace.yaml', orgNamespaceRoutes);
  app.use('/admin/users/:id/grants', userGrantsRoutes);
  app.use('/admin/users/:id/mfa-reset', mfaResetAdminRoutes);
  // nginx's auth_request gate for the admin consoles (pgAdmin/mongo-express/
  // Grafana/Kiali) on the AWS targets.
  app.use('/admin/console-check', adminConsoleRoutes);
  app.use('/admin/console-session', adminConsoleSessionRouter);
  app.use('/admin/summary', adminSummaryRoutes);
  app.use('/admin/impersonate', impersonateRoutes);
  // The cascade outbox's operator view and redrive (org purge / user erasure legs).
  app.use('/admin/cascade', cascadeAdminRoutes);
}
