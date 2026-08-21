// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireAuth, requirePermission, requireFeature, wireServiceSecurity } from '@pipeline-builder/api-core';
import { createApp, runServer, createAuthenticatedWithOrgRoute, attachRequestContext, postgresHealthCheck } from '@pipeline-builder/api-server';

import { createDeploymentOutcomeRoutes } from './routes/deployment-outcomes.js';
import { createEventIngestRoutes } from './routes/event-ingest.js';
import { createExecutionReportRoutes } from './routes/execution-reports.js';
import { createIncidentRoutes } from './routes/incidents.js';
import { createIngestHealthRoutes } from './routes/ingest-health.js';
import { createPluginReportRoutes } from './routes/plugin-reports.js';
import { createReportSettingsRoutes } from './routes/report-settings.js';
import { createRetentionSyncRoutes } from './routes/retention-sync.js';
import { getAuditClient } from './services/audit.js';
import { startReportingRetention, stopReportingRetention } from './services/reporting-retention.js';

const { app, sseManager } = createApp({ checkDependencies: postgresHealthCheck, jsonLimit: '5mb' });

// Boot security: forward denied authorizations to the authz.denied audit sink +
// register the env-Redis token-revocation reader (fail-open).
wireServiceSecurity('reporting', getAuditClient);

app.use(attachRequestContext(sseManager));

// Event ingest endpoint — auth required but no orgId (Lambda service account).
// Mounted at a distinct prefix so requireAuth doesn't double-run for
// /reports/execution and /reports/plugins below. NOT gated by `reports:read`:
// this is a machine WRITE path authorized inside the router by the
// `reporting:ingest` token scope, not a user dashboard read.
app.use('/reports/events', requireAuth, createEventIngestRoutes());

// Ingest-health endpoint — same machine credential as /reports/events (the
// `reporting:ingest` token scope is checked inside the router). Distinct prefix
// so requireAuth doesn't double-run for the user-facing report reads below.
app.use('/reports/ingest-health', requireAuth, createIngestHealthRoutes());

// Incident webhook (Phase 5) — same machine credential as /reports/events (the
// `reporting:ingest` token scope is checked inside the router). The user's
// PagerDuty/Datadog/Alertmanager posts here; DORA correlates each incident to a
// deploy for automated post-deploy CFR + real MTTR. Distinct prefix so
// requireAuth doesn't double-run for the user-facing report reads below. NOT
// gated by reports:read/advanced_reporting: it's a machine WRITE path (the DORA
// READ endpoints that consume this data carry the advanced_reporting gate).
// Incident webhook + org-admin config (Phase 5 / 5b). The webhook writes
// (`POST /`, `POST /alertmanager`) are machine — the `reporting:ingest` token
// scope is checked inside the router, mount is bare requireAuth so it doesn't
// double-run. The org-admin surfaces on this same router (`GET /`, `POST /test`)
// carry their OWN per-route guards (requireOrgId + tenant context + reports:read
// + advanced_reporting) so they get an orgId + RLS scope from the user JWT
// without a second mount.
app.use('/reports/incidents', requireAuth, createIncidentRoutes());

// Per-org reporting configuration (Phase 5b). User-facing: auth + orgId +
// `reports:read` + `advanced_reporting` (the DORA gate); the PUT adds an
// org-admin `org:settings` gate inside the router. Distinct prefix so requireAuth
// doesn't double-run.
app.use('/reports/settings', ...createAuthenticatedWithOrgRoute(), requirePermission('reports:read'), requireFeature('advanced_reporting'), createReportSettingsRoutes());

// Inbound billing → reporting retention sync (Phase 8). MACHINE write: billing
// pushes the account's effective retention entitlement (tier baseline + purchased
// retention bundles) onto the root org's `dora_settings`. Mounted at a bare
// `requireAuth` machine prefix (like /reports/events, /reports/incidents) — the
// service-principal / system-admin guard runs INSIDE the router (identical to the
// platform seat-limit sync leg billing already uses). NOT gated by reports:read /
// advanced_reporting / an org-user permission: the caller is the billing service
// token, not a user, and the target org is the `:orgId` path param.
app.use('/reports/retention-sync', requireAuth, createRetentionSyncRoutes());

// Post-deploy outcome markers (mark failed/restored). A user-facing DORA WRITE:
// same middleware pattern as the DORA reads — auth + orgId + `reports:read`,
// PLUS the `advanced_reporting` feature (DORA is a paid entitlement).
app.use('/reports/deployments', ...createAuthenticatedWithOrgRoute(), requirePermission('reports:read'), requireFeature('advanced_reporting'), createDeploymentOutcomeRoutes());

// Report query routes require auth + orgId + the `reports:read` capability.
// These are the user-facing dashboard reads; a custom role that withholds
// `reports:read` is blocked (built-in Member/Admin bundles include it). No
// internal service calls these query endpoints (only /reports/events ingest),
// so a plain user-facing gate — not requirePermissionOrService — is correct.
app.use('/reports/execution', ...createAuthenticatedWithOrgRoute(), requirePermission('reports:read'), createExecutionReportRoutes());
app.use('/reports/plugins', ...createAuthenticatedWithOrgRoute(), requirePermission('reports:read'), createPluginReportRoutes());

void runServer(app, {
  name: 'Reporting Service',
  sseManager,
  onShutdown: async () => { stopReportingRetention(); },
});

// Split, per-org reporting retention sweep (Phase 7): leader-locked + batched.
// Deletes expired pipeline_events / deployment_outcomes / incidents by created_at
// (standard-event vs DORA-source windows). Opt out with REPORTING_RETENTION_ENABLED=false.
startReportingRetention();
