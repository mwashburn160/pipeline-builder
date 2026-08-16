// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireAuth, requirePermission, wireServiceSecurity } from '@pipeline-builder/api-core';
import { createApp, runServer, createAuthenticatedWithOrgRoute, attachRequestContext, postgresHealthCheck } from '@pipeline-builder/api-server';

import { createEventIngestRoutes } from './routes/event-ingest.js';
import { createExecutionReportRoutes } from './routes/execution-reports.js';
import { createPluginReportRoutes } from './routes/plugin-reports.js';
import { getAuditClient } from './services/audit.js';

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

// Report query routes require auth + orgId + the `reports:read` capability.
// These are the user-facing dashboard reads; a custom role that withholds
// `reports:read` is blocked (built-in Member/Admin bundles include it). No
// internal service calls these query endpoints (only /reports/events ingest),
// so a plain user-facing gate — not requirePermissionOrService — is correct.
app.use('/reports/execution', ...createAuthenticatedWithOrgRoute(), requirePermission('reports:read'), createExecutionReportRoutes());
app.use('/reports/plugins', ...createAuthenticatedWithOrgRoute(), requirePermission('reports:read'), createPluginReportRoutes());

void runServer(app, { name: 'Reporting Service', sseManager });
