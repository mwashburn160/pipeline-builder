// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, requireAuth, setAuthzDenialAuditor, setTokenRevocationStore, createEnvRedisTokenRevocationStore } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext } from '@pipeline-builder/api-server';

import { config } from './config/index.js';
import { createAdminRoutes } from './routes/admin.js';
import { createImageRoutes } from './routes/images.js';
import { createTokenRoute } from './routes/token.js';
import { getAuditClient } from './services/audit.js';
import { startGcScheduler } from './services/gc-scheduler.js';

const logger = createLogger('pipeline-image-registry');

// Forward denied-authorization attempts to the remote audit trail. The shared
// api-core `requirePermission` / `requireSystemAdmin` gate invokes this ONLY
// when a state-changing (non-GET) request is actually rejected — probing /
// privilege-escalation signal that would otherwise be invisible. Best-effort:
// `record` never throws, and the gate wraps this call in try/catch regardless.
// (Routes gated purely by bearer-token scopes don't route through the gate, so
// this simply never fires for those — registering it is still correct.)
setAuthzDenialAuditor((info) => {
  getAuditClient().record({
    action: 'authz.denied',
    actorId: info.actorId ?? 'anonymous',
    ...(info.actorEmail && { actorEmail: info.actorEmail }),
    ...(info.orgId && { orgId: info.orgId }),
    outcome: 'failure',
    details: { method: info.method, path: info.path, required: info.required },
  }, 'image-registry');
});

// Reject tokens whose tokenVersion is behind the platform-published value once
// Redis is configured; fail-open (no-op) otherwise — falls back to token expiry.
setTokenRevocationStore(createEnvRedisTokenRevocationStore());

const { app, sseManager } = createApp({});

app.use(attachRequestContext(sseManager));

// Docker registry token endpoint  Basic auth (validated inside the route);
// must NOT go through requireAuth since it accepts platform-JWT-as-password
// AND (when PLATFORM_BASE_URL is set) `docker login` creds proxied to
// platform's /auth/login. The route itself returns 401 + WWW-Authenticate
// when creds are missing/invalid.
app.use('/token', createTokenRoute());

// Image management API  JWT-authenticated, system-admin gated per-route.
app.use('/api/images', requireAuth, createImageRoutes());

// Admin endpoints  per-namespace storage rollup + manual GC. Same auth
// + sysadmin gating as /api/images. Hit by the registry-gc CronJob daily
// to prune stale tags under each org's `org-X/` namespace.
app.use('/api/admin', requireAuth, createAdminRoutes());

runServer(app, {
  name: 'pipeline-image-registry',
  port: config.port,
  // image-registry doesn't use Postgres; skip the default DB health check so
  // pg's SASL client doesn't trip on the unset DB_PASSWORD env var.
  testDatabase: false,
  closeDatabase: false,
  onBeforeStart: async () => {
    logger.info('Service starting', {
      port: config.port,
      registryHost: config.registry.host,
      registryPort: config.registry.port,
    });
    // in-process periodic GC over `org-*` namespaces. Opt-in via
    // REGISTRY_GC_ENABLED=true; no-op otherwise so existing deployments
    // don't see surprise traffic on the registry.
    startGcScheduler();
  },
});

export { app };
