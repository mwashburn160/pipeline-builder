// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireAuth, requirePermission, requireFeature, type SseTicketStore } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, registerSseTicketChannel, type SSEManager } from '@pipeline-builder/api-server';
import type { Express, RequestHandler } from 'express';

import { createDeploymentOutcomeRoutes } from './routes/deployment-outcomes.js';
import { createEventIngestRoutes } from './routes/event-ingest.js';
import { createExecutionReportRoutes } from './routes/execution-reports.js';
import { createIncidentRoutes } from './routes/incidents.js';
import { createIngestHealthRoutes } from './routes/ingest-health.js';
import { createPluginReportRoutes } from './routes/plugin-reports.js';
import { createPublicReportRoutes } from './routes/public-reports.js';
import { createReportSettingsRoutes } from './routes/report-settings.js';
import { createRetentionSyncRoutes } from './routes/retention-sync.js';
import { createRetentionRoutes } from './routes/retention.js';
import { createReportPreviewRoutes } from './routes/report-preview.js';
import { createStakeholderInternalRoutes } from './routes/stakeholder-internal.js';
import { createStakeholderSyncRoutes } from './routes/stakeholder-sync.js';
import { createStakeholderReportRoutes } from './routes/stakeholder-reports.js';

/** Dependencies the route factories need. */
export interface ReportingRouteDeps {
  /** Drives the per-org live execution-status channel (an ingest pushes one frame per touched org). */
  sseManager: SSEManager;
  /** Single-use, org-bound ticket store backing the execution-status SSE channel. */
  executionTicketStore: SseTicketStore;
}

/**
 * Mount every reporting-service route on `app`. Shared by `index.ts` (the running
 * service) and the route-coverage test, so the route table the test checks is the
 * one production serves. Mount ORDER is load-bearing — see the comments below.
 */
export function mountRoutes(app: Express, { sseManager, executionTicketStore }: ReportingRouteDeps): void {
  // Event ingest endpoint — auth required but no orgId (Lambda service account).
  // Mounted at a distinct prefix so requireAuth doesn't double-run for
  // /reports/execution and /reports/plugins below. NOT gated by `reports:read`:
  // this is a machine WRITE path authorized inside the router by the
  // `reporting:ingest` token scope, not a user dashboard read.
  app.use('/reports/events', requireAuth, createEventIngestRoutes(sseManager));

  // ── Live execution-status channel (per-org SSE) ─────────────────────────────
  // Replaces the executions dashboard's manual-refresh/poll: after an ingest lands
  // new events for an org, event-ingest pushes an `execution-updated` frame to that
  // org's SSE subject (cross-pod via the SSEManager relay). Mirrors the message
  // service's org-scoped notification channel: a JWT is exchanged for a single-use,
  // org-bound ticket, then the EventSource opens with `?ticket=` so the JWT never
  // lands in a URL/access log.
  //
  // Shared org-SSE channel helper (same one the message service uses). The ticket
  // MINT is gated on reports:read so the live channel matches the data route's
  // authorization; the stream itself is authorized by the redeemed ticket alone.
  registerSseTicketChannel(app, {
    ticketPath: '/reports/execution/stream/ticket',
    streamPath: '/reports/execution/stream',
    ticketStore: executionTicketStore,
    sseManager,
    label: 'execution-stream',
    ticketGuards: [requirePermission('reports:read') as RequestHandler],
  });

  // Ingest-health endpoint — the POST uses the same machine credential as
  // /reports/events (the `reporting:ingest` token scope is checked inside the
  // router). The GET on this same router is USER-facing (the Reports freshness
  // indicator) and carries its own per-route guards — requireOrgId + tenant
  // context + `reports:read` — exactly like the incidents router's admin reads.
  // Distinct prefix so requireAuth doesn't double-run for the reads below.
  app.use('/reports/ingest-health', requireAuth, createIngestHealthRoutes());

  // Incident webhook + org-admin config. The user's PagerDuty/Datadog/Alertmanager
  // posts here and DORA correlates each incident to a deploy for automated
  // post-deploy CFR + real MTTR. The webhook writes (`POST /`, `POST
  // /alertmanager`) are machine — the `reporting:ingest` token scope is checked
  // inside the router, and the mount is bare requireAuth so it doesn't double-run.
  // They are NOT gated by reports:read/advanced_reporting (the DORA READ endpoints
  // that consume this data carry that gate). The org-admin surfaces on this same
  // router (`GET /`, `POST /test`) carry their OWN per-route guards (requireOrgId
  // + tenant context + reports:read + advanced_reporting) so they get an orgId +
  // RLS scope from the user JWT without a second mount.
  app.use('/reports/incidents', requireAuth, createIncidentRoutes());

  // Per-org reporting configuration. User-facing: auth + orgId +
  // `reports:read` + `advanced_reporting` (the DORA gate); the PUT adds an
  // org-admin `org:settings` gate inside the router. Distinct prefix so requireAuth
  // doesn't double-run.
  app.use('/reports/settings', ...createAuthenticatedWithOrgRoute(), requirePermission('reports:read'), requireFeature('advanced_reporting'), createReportSettingsRoutes());

  // The org's effective retention horizon, read-only. `reports:read` only — NOT
  // `advanced_reporting`: the Retention Pack is sold to every tier and widens the
  // standard reports, so the Reports date-range cap must be readable without the
  // DORA entitlement. Distinct from `/reports/retention-sync` (express matches
  // whole path segments, so this mount never sees the machine sync leg).
  app.use('/reports/retention', ...createAuthenticatedWithOrgRoute(), requirePermission('reports:read'), createRetentionRoutes());

  // Inbound billing → reporting retention sync. MACHINE write: billing pushes the
  // account's effective retention entitlement (tier baseline + purchased retention
  // bundles) onto the root org's `dora_settings`. Mounted at a bare `requireAuth`
  // machine prefix (like /reports/events, /reports/incidents) — the internal-service
  // guard (billing's own signed token only) runs INSIDE the router. NOT gated by
  // reports:read / advanced_reporting / an org-user permission: the caller is the
  // billing service token, not a user, and the target org is the `:orgId` path param.
  app.use('/reports/retention-sync', requireAuth, createRetentionSyncRoutes());

  // Post-deploy outcome markers (mark failed/restored). A user-facing DORA WRITE
  // that changes the org's change-failure rate + MTTR, so it is gated by a WRITE
  // permission — `pipelines:write` (the outcome is recorded against a pipeline
  // deployment; built-in Member/Admin carry it) — not the read-only `reports:read`
  // a report viewer holds. Plus `advanced_reporting` (DORA is a paid entitlement).
  app.use('/reports/deployments', ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:write'), requireFeature('advanced_reporting'), createDeploymentOutcomeRoutes());

  // ── Stakeholder reports (the add-on) ───────────────────────────────────────
  // Saved, scheduled, manager-facing reports: definitions, runs, publish, share
  // links and the distribution list. Auth + orgId + tenant context, then the
  // `stakeholder_reports` FEATURE gate for the whole surface — the on-demand
  // dashboards under /reports/execution stay free on `reports:read`; what is sold
  // here is saving, scheduling and publishing. Per-route permissions inside the
  // router split it three ways: `reports:read` to look, `reports:author` to
  // compose, `reports:share` to publish and mint links (see the router's header).
  app.use('/reports/stakeholder', ...createAuthenticatedWithOrgRoute(), requireFeature('stakeholder_reports'), createStakeholderReportRoutes());

  // The FREE PREVIEW: one watermarked sample report for an org that has NOT bought the
  // add-on, so it is deliberately mounted OUTSIDE the feature gate above. Nothing is
  // persisted, which is what makes it unschedulable and unshareable structurally rather
  // than by a flag every future caller has to remember to check. `reports:author` on the
  // POST (composing is the authoring act), `reports:read` on the "already used?" GET.
  app.use('/reports/stakeholder-preview', ...createAuthenticatedWithOrgRoute(), createReportPreviewRoutes());

  // Inbound billing → reporting: the account gained or lost the add-on. Pauses or
  // resumes every report in the ACCOUNT (root + teams). MACHINE write on the same bare
  // `requireAuth` machine prefix as /reports/retention-sync — the internal-service guard
  // runs inside the router and the target root org is the `:orgId` path param.
  app.use('/reports/stakeholder-sync', requireAuth, createStakeholderSyncRoutes());

  // Inbound platform → reporting: a member was deactivated or removed, so the
  // report definitions they OWN must stop (a scheduled run is authorized as its
  // owner). MACHINE write on a bare `requireAuth` machine prefix like
  // /reports/events and /reports/retention-sync — the internal-service guard
  // (platform's own signed token) runs INSIDE the router, the target org is the
  // `:orgId` path param, and there is no user permission or feature entitlement to
  // check because there is no user.
  app.use('/reports/stakeholder-internal', requireAuth, createStakeholderInternalRoutes());

  // ── The public, UNAUTHENTICATED half ───────────────────────────────────────
  // A shared report and a recipient's own address confirmation, both authorized
  // by a token in the request rather than a session, because the manager reading
  // a report and the person confirming their email have no account here. Mounted
  // BEFORE nothing and under its own prefix, with NO auth middleware at all:
  // adding requireAuth would break the only readers it exists for. The token is
  // the authorization, the router rate-limits per client IP, and every response
  // carries noindex / no-referrer / private-no-store (see the router's header for
  // the full reasoning and what the link cannot do).
  app.use('/public', createPublicReportRoutes());

  // Report query routes require auth + orgId + the `reports:read` capability.
  // These are the user-facing dashboard reads; a custom role that withholds
  // `reports:read` is blocked (built-in Member/Admin bundles include it). No
  // internal service calls these query endpoints (only /reports/events ingest),
  // so a plain user-facing gate — not requirePermissionOrService — is correct.
  app.use('/reports/execution', ...createAuthenticatedWithOrgRoute(), requirePermission('reports:read'), createExecutionReportRoutes());
  app.use('/reports/plugins', ...createAuthenticatedWithOrgRoute(), requirePermission('reports:read'), createPluginReportRoutes());
}
