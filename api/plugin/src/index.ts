// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, createRedisTokenRevocationStore, registerComplianceEventSubscriber, setApiKeyExchangeServiceName, wireAuthzDenialAuditor, setTokenRevocationStore } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, postgresHealthCheck, redisHealthCheck, combineHealthChecks } from '@pipeline-builder/api-server';
import { createSoftDeletePurgeScheduler } from '@pipeline-builder/pipeline-data';

import { mountRoutes } from './app-routes.js';
import { getHealthRedisConnection } from './queue/connections.js';
import { startWorker, waitForWorkerReady, shutdownQueue } from './queue/plugin-build-queue.js';
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

// -- Access-key exchange identity ---------------------------------------------
// Name this process in the service token the opaque-key exchange call carries
// (the other services get this from `wireServiceSecurity`, which plugin opts out
// of because it shares the Redis connection above).
setApiKeyExchangeServiceName('plugin');

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

mountRoutes(app, { quotaService, sseManager });

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
