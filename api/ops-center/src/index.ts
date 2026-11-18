// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ops-center — the operations control plane, split out of platform (the
 * identity hub): the Prometheus / Loki / Alertmanager proxy behind the
 * dashboards, the dashboards themselves, org alert rules and destinations, the
 * Alertmanager relay + on-call paging, and the PVC / node-disk / Postgres-rung
 * auto-scaling webhooks. Postgres + Redis only; identity facts come from
 * platform through typed internal contracts (services/platform-client.ts).
 *
 * OpenTelemetry is initialized by the `@pipeline-builder/api-server/otel-bootstrap`
 * preload (see Dockerfile / start script), not here.
 */

import { createLogger, reportAlertDeliveryPosture, startDeadmanHeartbeat, stopDeadmanHeartbeat, wireServiceSecurity, type Scheduler } from '@pipeline-builder/api-core';
import { attachRequestContext, createApp, postgresHealthCheck, runServer } from '@pipeline-builder/api-server';

import { mountRoutes, ONCALL_ACK_PATH } from './app-routes.js';
import { registerOpsSecretRotationProbes } from './observability/secret-rotation.js';
import { registerBackgroundSweeps } from './services/background-sweeps.js';
import { seedDefaultDashboards } from './services/dashboard-seeder.js';
import { refreshEmailEnabled } from './services/notification-channels.js';

const logger = createLogger('ops-center');

// The global IP limiter is OFF: this service's buckets are per surface
// (middleware/limiters.ts) — the Alertmanager relay must never share an
// anonymous per-IP budget, and the tenant buckets key on the verified org.
const { app, sseManager } = createApp({
  checkDependencies: postgresHealthCheck,
  enableRateLimit: false,
  jsonBodyExclude: [ONCALL_ACK_PATH],
});

// Boot security: forward denied authorizations to the authz.denied audit sink +
// register the env-Redis token-revocation reader (fail-open). Also binds
// `recordAudit` to this service.
wireServiceSecurity('ops-center');

app.use(attachRequestContext(sseManager));
mountRoutes(app);

// `secret_rotation_previous_set{secret="ALERT_WEBHOOK_INSTANCE_TOKEN"}`.
registerOpsSecretRotationProbes();
// Alert-delivery posture: `alert_delivery_enabled{channel}` /
// `alert_delivery_configured{channel}` — a STATE of the deployment, logged
// loudly when incoherent (paging on with no routing key, no destination at all).
reportAlertDeliveryPosture();
// The dead-man switch lives with the paging path: if this service stops, so
// does paging, so its SILENCE is the alert. Per-process, deliberately not
// leader-locked (silence must mean every replica stopped).
if (startDeadmanHeartbeat()) logger.info('On-call dead-man heartbeat started — its ABSENCE is the alert');

const sweeps: Scheduler[] = [];

void runServer(app, {
  name: 'Ops Controller',
  sseManager,
  onStart: () => {
    refreshEmailEnabled();
    // Seed default dashboards into Postgres (idempotent, fire-and-forget).
    void seedDefaultDashboards();
    void registerBackgroundSweeps().then((started) => { sweeps.push(...started); });
  },
  onShutdown: async () => {
    stopDeadmanHeartbeat();
    for (const sweep of sweeps) sweep.stop();
  },
});
