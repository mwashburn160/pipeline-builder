// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, createRedisTokenRevocationStore, registerComplianceEventSubscriber, requireFeature, requirePermission, requireStepUp, wireAuthzDenialAuditor, setTokenRevocationStore } from '@pipeline-builder/api-core';
import { createApp, runServer, createProtectedRoute, createAuthenticatedWithOrgRoute, attachRequestContext, postgresHealthCheck, redisHealthCheck, combineHealthChecks } from '@pipeline-builder/api-server';
import { createSoftDeletePurgeScheduler } from '@pipeline-builder/pipeline-data';

import { startWorker, waitForWorkerReady, shutdownQueue, getHealthRedisConnection } from './queue/plugin-build-queue.js';
import { createBulkPluginRoutes } from './routes/bulk-plugin.js';
import { createDeletePluginRoutes } from './routes/delete-plugin.js';
import { createDeployGeneratedPluginRoutes } from './routes/deploy-generated-plugin.js';
import { createGeneratePluginRoutes } from './routes/generate-plugin.js';
import { createPurgePluginRoutes } from './routes/purge-plugin.js';
import { createQueueStatusRoutes } from './routes/queue-status.js';
import { createReadPluginRoutes } from './routes/read-plugins.js';
import { createRestorePluginRoutes } from './routes/restore-plugin.js';
import { createUpdatePluginRoutes } from './routes/update-plugin.js';
import { createUploadPluginRoutes } from './routes/upload-plugin.js';
import { getAuditClient } from './services/audit.js';
import { pluginService } from './services/plugin-service.js';

const logger = createLogger('plugin');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({
  // Plugin depends on BOTH postgres and redis (the BullMQ build queue) — probe
  // each in parallel rather than reporting redis as always-connected.
  checkDependencies: combineHealthChecks(
    () => postgresHealthCheck(),
    redisHealthCheck(() => getHealthRedisConnection()),
  ),
});

// -- Failed-authorization auditor --------------------------------------------
// Register a process-wide sink so the shared `requirePermission` /
// `requireSystemAdmin` gate forwards every denied state-changing request into
// the platform audit log as an `authz.denied` failure. Best-effort: the gate
// wraps this in try/catch and `record` never throws.
wireAuthzDenialAuditor('plugin', getAuditClient);

// -- Token-revocation reader (session-invalidation option b) ------------------
// Reuse the same pooled ioredis connection (db 0) the BullMQ build queue and the
// readiness probe already share, so the shared `requireAuth` can reject a token
// whose `tokenVersion` is behind the version the platform published on a
// privilege change. Fail-open by contract: a Redis miss/outage yields null and
// auth degrades to natural token expiry rather than locking users out.
setTokenRevocationStore(createRedisTokenRevocationStore(getHealthRedisConnection()));

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- Upload route FIRST — manages its own middleware (multer → auth → plugins quota).
//    Must be registered before other /plugins routes so that their auth/quota
//    middleware does not run on multipart uploads before multer can parse the body.
app.use('/plugins', createUploadPluginRoutes(quotaService, sseManager));

// -- Queue status route (MUST be before read routes to avoid /:id catching "queue")
app.use('/plugins/queue', ...createAuthenticatedWithOrgRoute(), createQueueStatusRoutes(quotaService));

// -- AI generation routes (MUST be before read routes). Auth + orgId stays at the
//    mount (reads require auth anyway, so it can't over-gate them), but the
//    `ai_generation` feature gate lives on each generate route inside the router
//    (see generate-plugin.ts) so it can't leak onto sibling `GET /plugins` reads.
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), createGeneratePluginRoutes(quotaService));

// -- Deploy AI-generated plugin — manages its own admin + quota middleware
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), createDeployGeneratedPluginRoutes(quotaService, sseManager));

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/plugins', ...createProtectedRoute(quotaService, 'apiCalls'), createReadPluginRoutes(quotaService));

// -- Update route — auth + orgId + plugins:write (no quota check) -------------
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), requirePermission('plugins:write'), createUpdatePluginRoutes());

// -- Delete route — auth + orgId + plugins:write (admin-only also in handler) -
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), requirePermission('plugins:write'), createDeletePluginRoutes());

// -- Restore route — auth + orgId + plugins:write + step-up -------------------
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), requirePermission('plugins:write'), requireStepUp, createRestorePluginRoutes());

// -- Purge route — auth + orgId + plugins:write + step-up --------------------
// Manual, on-demand permanent hard-delete of an already soft-deleted tombstone
// (finalizes what the retention sweep would do later). Same write authority as
// restore, and — like restore — behind `requireStepUp`: purge is an
// irreversible destructive act, so it requires a password re-verify in addition
// to the frontend confirm dialog. The frontend sends the step-up token in the
// same header restore uses.
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), requirePermission('plugins:write'), requireStepUp, createPurgePluginRoutes());

// -- Bulk routes — auth + orgId + plugins:write + bulk_operations feature gate -
app.use('/plugins', ...createAuthenticatedWithOrgRoute(), requirePermission('plugins:write'), requireFeature('bulk_operations'), createBulkPluginRoutes());

// -- Start BullMQ worker for async Docker builds ----------------------------
startWorker(sseManager, quotaService);

// -- Register compliance event subscriber for entity lifecycle events --------
// `'plugin'` is the service principal baked into the signed JWT the
// subscriber mints per event (the compliance route requires a service
// principal — the previous spoofable `x-internal-service` header is gone).
registerComplianceEventSubscriber(undefined, 'plugin');

logger.info('All /plugins routes registered');

// Retention purge: hard-delete plugin tombstones past their `purge_after`
// deadline. Leader-locked (one replica per window) and sysadmin-scoped inside
// the sweep so it spans all orgs. Opt out with SOFT_DELETE_PURGE_ENABLED=false.
// Created before runServer so teardown rides its coordinated onShutdown.
const purgeScheduler = createSoftDeletePurgeScheduler({
  service: 'plugin',
  entities: [
    { name: 'plugin', purgeExpired: (now, limit) => pluginService.purgeExpired(now, limit) },
  ],
});

void runServer(app, {
  name: 'Plugin Service',
  sseManager,
  onBeforeStart: () => waitForWorkerReady(),
  onShutdown: async () => { await shutdownQueue(); purgeScheduler?.stop(); },
});
purgeScheduler?.start();
