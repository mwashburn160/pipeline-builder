// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, wireServiceSecurity } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, createAuthenticatedWithOrgRoute, rateLimitByOrg } from '@pipeline-builder/api-server';

import { createAgentRoutes } from './routes/agent.js';
import { createAskRoutes } from './routes/ask.js';
import { getAuditClient } from './services/audit.js';
import { getDocsIndex } from './services/docs-index.js';

const logger = createLogger('ask');
const quotaService = createQuotaService();

// The ask service has no database — v1 conversation state is client-held and the
// grounding corpus is read from the filesystem — so it needs no dependency health
// check beyond the app's own liveness.
const { app, sseManager } = createApp();

// Forward denied (non-GET) requests to the shared authz.denied audit sink.
wireServiceSecurity('ask', getAuditClient);

// Attach request context (identity + logging) to all requests.
app.use(attachRequestContext(sseManager));

// -- /ask routes --------------------------------------------------------------
// Auth + orgId at the mount; each handler adds requireFeature('ai_generation').
// rateLimitByOrg caps LLM spend per tenant (keyed on the verified org, service
// principals exempt) and must run after auth. Reuses the existing ai_generation
// entitlement for v1.
app.use(
  '/ask',
  ...createAuthenticatedWithOrgRoute(),
  rateLimitByOrg({ name: 'ask', max: 30, windowMs: 60_000, message: 'Too many Ask requests' }),
  createAskRoutes(quotaService),
  createAgentRoutes(quotaService),
);

logger.info('All /ask routes registered');

// Warm the docs grounding index at boot so the first request isn't slow (and so a
// missing/empty corpus is visible in the logs immediately).
getDocsIndex()
  .then((index) => logger.info('Ask docs index ready', { chunks: index.size }))
  .catch((err) => logger.error('Failed to build ask docs index', { error: String(err) }));

runServer(app, { name: 'Ask Service' });
