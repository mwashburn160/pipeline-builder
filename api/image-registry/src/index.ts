// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, wireServiceSecurity } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext } from '@pipeline-builder/api-server';

import { mountRoutes } from './app-routes.js';
import { config } from './config/index.js';
import { PLUGIN_SIGNATURES_PATH } from './routes/internal.js';
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
wireServiceSecurity('image-registry', getAuditClient);

// The plugin-signature route carries a multi-MB SBOM and parses its own body
// with a larger limit, so the global 1mb JSON parser must skip it.
const { app, sseManager } = createApp({ jsonBodyExclude: [PLUGIN_SIGNATURES_PATH] });

app.use(attachRequestContext(sseManager));

mountRoutes(app);

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
