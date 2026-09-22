// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, createRedisTokenRevocationStore, registerComplianceEventSubscriber, wireServiceSecurity } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, postgresHealthCheck, redisHealthCheck, combineHealthChecks } from '@pipeline-builder/api-server';
import { createSoftDeletePurgeScheduler } from '@pipeline-builder/pipeline-data';

import { mountRoutes } from './app-routes.js';
import { getHealthRedisConnection } from './queue/connections.js';
import { startWorker, waitForWorkerReady, shutdownQueue } from './queue/plugin-build-queue.js';
import { shutdownSubmissionQueue, startSubmissionWorker } from './queue/submission-build-queue.js';
import { createVulnRescanScheduler } from './queue/vuln-rescan.js';
import { getAuditClient } from './services/audit.js';
import { createEcosystemMaintenanceScheduler } from './services/ecosystem/maintenance.js';
import { createEcosystemMetricsScheduler } from './services/ecosystem/metrics.js';
import { ensureOfficialPublisher } from './services/ecosystem/publishers.js';
import { createEcosystemStatsScheduler } from './services/ecosystem/stats.js';
import { createEcosystemNotificationScheduler } from './services/ecosystem-notifications.js';
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
// Anonymous-submission gate runs (§4): their own queue + single worker, never
// the tenant build processor. Idle unless ANONYMOUS_SUBMISSIONS_ENABLED.
startSubmissionWorker();

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

// Nightly vulnerability rescan (W0.6): re-scans every image plugin's signed
// SBOM against a freshly refreshed grype DB, since new CVEs land against
// packages that were clean at build. Leader-locked on the shared Redis (one pod
// per tick) and interval-gated on the last completed pass, so N replicas still
// rescan once per interval. Opt out with PLUGIN_RESCAN_ENABLED=false.
const rescanScheduler = createVulnRescanScheduler();

// Plugin-ecosystem notification digests (plan §5b): flushes
// ecosystem_notification_queue once a minute, leader-locked on the shared Redis.
const ecosystemNotificationScheduler = createEcosystemNotificationScheduler(getHealthRedisConnection);

// Plugin-ecosystem upkeep (plan §3.3, §3.7): Verified grace periods and
// listings-limit notices after a plan change, and the re-sign job queue.
// Leader-locked on the shared Redis.
const ecosystemMaintenanceScheduler = createEcosystemMaintenanceScheduler(getHealthRedisConnection);

// Plugin-ecosystem gauges (plan §9a: queue depth, oldest pending, SLA breaches,
// re-sign jobs, approvers). Every replica samples (no lock), so the scraped pod
// is never a stale former leader.
const ecosystemMetricsScheduler = createEcosystemMetricsScheduler();

// Plugin-ecosystem directory stats (plan §5, W4): ratings, install counts and
// k-anonymous adoption in plugin_stats, which the public directory sorts by.
// Leader-locked on the shared Redis; review writes also refresh their listing.
const ecosystemStatsScheduler = createEcosystemStatsScheduler(getHealthRedisConnection);

void runServer(app, {
  name: 'Plugin Service',
  sseManager,
  onBeforeStart: async () => {
    await waitForWorkerReady();
    // The Official catalog publisher must belong to THIS instance's system org
    // (postgres-init seeds the default id). Best-effort: a failure is logged
    // and the next boot retries.
    await ensureOfficialPublisher().catch((err: Error) => logger.warn('Could not assert the Official publisher', { error: err.message }));
  },
  onShutdown: async () => {
    await shutdownQueue(); await shutdownSubmissionQueue(); purgeScheduler?.stop(); rescanScheduler?.stop(); ecosystemNotificationScheduler.stop(); ecosystemMaintenanceScheduler.stop(); ecosystemMetricsScheduler.stop(); ecosystemStatsScheduler.stop();
  },
});
purgeScheduler?.start();
rescanScheduler?.start();
ecosystemNotificationScheduler.start();
ecosystemMaintenanceScheduler.start();
ecosystemMetricsScheduler.start();
ecosystemStatsScheduler.start();
