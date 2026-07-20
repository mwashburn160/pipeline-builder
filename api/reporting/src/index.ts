// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireAuth, setAuthzDenialAuditor } from '@pipeline-builder/api-core';
import { createApp, runServer, createAuthenticatedWithOrgRoute, attachRequestContext, postgresHealthCheck } from '@pipeline-builder/api-server';

import { createEventIngestRoutes } from './routes/event-ingest.js';
import { createExecutionReportRoutes } from './routes/execution-reports.js';
import { createPluginReportRoutes } from './routes/plugin-reports.js';
import { getAuditClient } from './services/audit.js';

const { app, sseManager } = createApp({ checkDependencies: postgresHealthCheck, jsonLimit: '5mb' });

// -- Failed-authorization auditor (#5) ----------------------------------------
// Forward denials from the shared requirePermission / requireSystemAdmin gate to
// platform's audit ingest as `authz.denied`, best-effort (the gate try/catches).
setAuthzDenialAuditor((info) => getAuditClient().record({
  action: 'authz.denied',
  actorId: info.actorId ?? 'anonymous',
  actorEmail: info.actorEmail,
  orgId: info.orgId,
  outcome: 'failure',
  details: { method: info.method, path: info.path, required: info.required },
}, 'reporting'));

app.use(attachRequestContext(sseManager));

// Event ingest endpoint — auth required but no orgId (Lambda service account).
// Mounted at a distinct prefix so requireAuth doesn't double-run for
// /reports/execution and /reports/plugins below.
app.use('/reports/events', requireAuth, createEventIngestRoutes());

// Report query routes require auth + orgId
app.use('/reports/execution', ...createAuthenticatedWithOrgRoute(), createExecutionReportRoutes());
app.use('/reports/plugins', ...createAuthenticatedWithOrgRoute(), createPluginReportRoutes());

void runServer(app, { name: 'Reporting Service', sseManager });
