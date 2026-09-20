// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, createRedisTokenRevocationStore, registerComplianceEventSubscriber, wireServiceSecurity } from '@pipeline-builder/api-core';
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

// -- Shared boot security -----------------------------------------------------
// The SAME wiring every other service uses: the `authz.denied` audit sink, the
// token-revocation reader, and this process's name in the access-key exchange
// token. Plugin previously hand-rolled these three calls (so any concern added
// to `wireServiceSecurity` would have silently skipped it); the one thing it
// actually needs differently — a revocation store on the pooled ioredis
// connection the BullMQ build queue and the readiness probe already share,
// rather than a second env-Redis connection — is now an override.
wireServiceSecurity('plugin', getAuditClient, {
  tokenRevocationStore: createRedisTokenRevocationStore(getHealthRedisConnection()),
});

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
