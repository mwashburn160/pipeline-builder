// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, requireAuth } from '@pipeline-builder/api-core';
import { createApp, runServer, createAuthenticatedWithOrgRoute, attachRequestContext, postgresHealthCheck } from '@pipeline-builder/api-server';

import { createEventIngestRoutes } from './routes/event-ingest';
import { createExecutionReportRoutes } from './routes/execution-reports';
import { createPluginReportRoutes } from './routes/plugin-reports';

const logger = createLogger('reporting');
const { app, sseManager } = createApp({ checkDependencies: postgresHealthCheck });

app.use(attachRequestContext(sseManager));

// Event ingest endpoint — auth required but no orgId (Lambda service account)
app.use('/reports', requireAuth, createEventIngestRoutes());

// Report query routes require auth + orgId
app.use('/reports/execution', ...createAuthenticatedWithOrgRoute(), createExecutionReportRoutes());
app.use('/reports/plugins', ...createAuthenticatedWithOrgRoute(), createPluginReportRoutes());

logger.info('All /reports routes registered');

void runServer(app, { name: 'Reporting Service', sseManager });
