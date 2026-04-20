// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, requireAuth } from '@pipeline-builder/api-core';
import { createApp, runServer, createAuthenticatedWithOrgRoute, attachRequestContext } from '@pipeline-builder/api-server';
import { db } from '@pipeline-builder/pipeline-core';
import { sql } from 'drizzle-orm';

import { createEventIngestRoutes } from './routes/event-ingest';
import { createExecutionReportRoutes } from './routes/execution-reports';
import { createPluginReportRoutes } from './routes/plugin-reports';

const logger = createLogger('reporting');
const { app, sseManager } = createApp({
  checkDependencies: async () => {
    try { await db.execute(sql`SELECT 1`); return { postgres: 'connected' as const }; } catch { return { postgres: 'unknown' as const }; }
  },
});

app.use(attachRequestContext(sseManager));

// Event ingest endpoint — auth required but no orgId (Lambda service account)
app.use('/reports', requireAuth, createEventIngestRoutes());

// Report query routes require auth + orgId
app.use('/reports/execution', ...createAuthenticatedWithOrgRoute(), createExecutionReportRoutes());
app.use('/reports/plugins', ...createAuthenticatedWithOrgRoute(), createPluginReportRoutes());

logger.info('All /reports routes registered');

void runServer(app, { name: 'Reporting Service', sseManager });
