// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, wireServiceSecurity } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext } from '@pipeline-builder/api-server';

import { mountRoutes } from './app-routes.js';
import { getDocsIndex } from './services/docs-index.js';

const logger = createLogger('ask');
const quotaService = createQuotaService();

// The ask service has no database — v1 conversation state is client-held and the
// grounding corpus is read from the filesystem — so it needs no dependency health
// check beyond the app's own liveness.
const { app, sseManager } = createApp();

// Forward denied (non-GET) requests to the shared authz.denied audit sink.
wireServiceSecurity('ask');

// Attach request context (identity + logging) to all requests.
app.use(attachRequestContext(sseManager));

mountRoutes(app, { quotaService });

logger.info('All /ask routes registered');

// Warm the docs grounding index at boot so the first request isn't slow (and so a
// missing/empty corpus is visible in the logs immediately).
getDocsIndex()
  .then((index) => logger.info('Ask docs index ready', { chunks: index.size }))
  .catch((err) => logger.error('Failed to build ask docs index', { error: String(err) }));

// No datastore (see above): skip runServer's default PostgreSQL readiness probe.
// Left on, the readiness guard would 503 every request until a Postgres
// connection the service never uses succeeds — and the mesh (correctly) doesn't
// let ask reach Postgres, so it never would.
runServer(app, { name: 'Ask Service', testDatabase: false, closeDatabase: false });
