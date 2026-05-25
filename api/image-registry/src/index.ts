// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, requireAuth } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext } from '@pipeline-builder/api-server';

import { config } from './config';
import { createAdminRoutes } from './routes/admin';
import { createImageRoutes } from './routes/images';
import { createTokenRoute } from './routes/token';
import { startGcScheduler } from './services/gc-scheduler';

const logger = createLogger('pipeline-image-registry');

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
