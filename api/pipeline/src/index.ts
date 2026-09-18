// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, registerComplianceEventSubscriber, wireServiceSecurity } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, postgresHealthCheck } from '@pipeline-builder/api-server';
import { createSoftDeletePurgeScheduler } from '@pipeline-builder/pipeline-data';

import { mountRoutes } from './app-routes.js';
import { getAuditClient } from './services/audit.js';
import { pipelineService } from './services/pipeline-service.js';
import { pipelineTemplateService } from './services/pipeline-template-service.js';

const logger = createLogger('pipeline');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({ checkDependencies: postgresHealthCheck });

// Forward denied (non-GET) requests to the shared authz.denied audit sink.
wireServiceSecurity('pipeline', getAuditClient);

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

mountRoutes(app, { quotaService });

// -- Register compliance event subscriber for entity lifecycle events --------
// `'pipeline'` is the service principal baked into the signed JWT the
// subscriber mints per event (the compliance route requires a service
// principal — the previous spoofable `x-internal-service` header is gone).
registerComplianceEventSubscriber(undefined, 'pipeline');

logger.info('All /pipelines routes registered');

// Retention purge: hard-delete pipeline + pipeline_template tombstones past
// their `purge_after` deadline. Leader-locked (one replica per window) and
// sysadmin-scoped inside the sweep so it spans all orgs. Opt out with
// SOFT_DELETE_PURGE_ENABLED=false. Created before runServer so its teardown
// rides runServer's coordinated onShutdown (not a racing process.once).
const purgeScheduler = createSoftDeletePurgeScheduler({
  service: 'pipeline',
  entities: [
    { name: 'pipeline', purgeExpired: (now, limit) => pipelineService.purgeExpired(now, limit) },
    { name: 'pipeline_template', purgeExpired: (now, limit) => pipelineTemplateService.purgeExpired(now, limit) },
  ],
});

void runServer(app, {
  name: 'Pipeline Service',
  sseManager,
  // No boot-time migrations: the schema is owned by postgres-init.sql and the
  // service connects as a non-superuser app role without DDL rights.
  onShutdown: async () => { purgeScheduler?.stop(); },
});
purgeScheduler?.start();
