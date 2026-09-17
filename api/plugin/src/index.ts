// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, createRedisTokenRevocationStore, registerComplianceEventSubscriber, requirePermission, requireStepUp, wireAuthzDenialAuditor, setTokenRevocationStore } from '@pipeline-builder/api-core';
import { createApp, runServer, checkQuota, createAuthenticatedWithOrgRoute, attachRequestContext, postgresHealthCheck, redisHealthCheck, combineHealthChecks } from '@pipeline-builder/api-server';
import { createSoftDeletePurgeScheduler } from '@pipeline-builder/pipeline-data';

import { getHealthRedisConnection } from './queue/connections.js';
import { startWorker, waitForWorkerReady, shutdownQueue } from './queue/plugin-build-queue.js';
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
  // Plugin is the one service that streams build logs over SSE (/logs/ticket,
  // /logs/:requestId). Every other service leaves this off.
  logStream: true,
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

// -- Upload route FIRST — manages its own middleware (auth → orgId →
//    plugins:write → rate limit → multer → tenant scope). Must be registered
//    before the shared chain below so no auth/quota middleware runs on a
//    multipart upload before multer can parse the body. It only matches
//    `POST /plugins`; everything else falls straight through.
app.use('/plugins', createUploadPluginRoutes(quotaService, sseManager));

// -- ONE shared auth + orgId + idempotency + tenant-scope pass ---------------
// Every remaining /plugins route shares this single prefix chain, and each
// mount below adds only its own gates. Stacking a separate
// `createAuthenticatedWithOrgRoute()` / `createProtectedRoute()` in front of
// each router re-ran the idempotency middleware for every mount a request fell
// through: the second pass found the FIRST pass's pending reservation under the
// same key and answered 409 (e.g. `POST /plugins/deploy-generated` with an
// Idempotency-Key, which falls through the generate mount first).
//
// Gates added by a mount are PREFIX layers, so they also run for every request
// that falls through to a later mount — the order below is load-bearing.
app.use('/plugins', ...createAuthenticatedWithOrgRoute());

// -- Queue status routes (MUST be before read routes so `/:id` can't catch "queue").
app.use('/plugins/queue', createQueueStatusRoutes(quotaService));

// -- AI generation routes (MUST be before read routes). The `ai_generation`
//    feature gate lives on each generate route inside the router (see
//    generate-plugin.ts) so it can't leak onto sibling `GET /plugins` reads.
app.use('/plugins', createGeneratePluginRoutes(quotaService));

// -- Deploy AI-generated plugin — owns its plugins:write gate + quota reservation.
app.use('/plugins', createDeployGeneratedPluginRoutes(quotaService, sseManager));

// -- Read routes (list, find, get-by-id) — + apiCalls quota check. The check is a
//    prefix layer, so the write mounts below it are metered the same way.
app.use('/plugins', checkQuota(quotaService, 'apiCalls'), createReadPluginRoutes(quotaService));

// -- Write routes — + plugins:write, ONE mount so the gate runs once --------
//   - update / delete: plugins:write (delete's per-row publish gate is in-handler).
//   - bulk: + `bulk_operations`, attached per route inside the router so the
//     feature gate can't leak onto purge/restore. Mounted BEFORE `requireStepUp`
//     so bulk calls don't require (and aren't blocked by) a step-up token.
//   - purge / restore: + step-up (password re-verify). Purge is an irreversible
//     hard-delete of a tombstone; restore reverses a soft-delete. `requireStepUp`
//     consumes the step-up token's `jti` ONCE, so both routers sit behind a
//     SINGLE step-up layer: a separate step-up mount per router made whichever
//     came second see its own already-consumed jti (401 STEP_UP_REPLAY), and
//     anything mounted after both (bulk) hit STEP_UP_REQUIRED.
app.use(
  '/plugins',
  requirePermission('plugins:write'),
  createUpdatePluginRoutes(),
  createDeletePluginRoutes(),
  createBulkPluginRoutes(),
  requireStepUp,
  createPurgePluginRoutes(),
  createRestorePluginRoutes(),
);

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
