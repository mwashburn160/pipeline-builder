// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, SSE_TICKET_TTL_MS, wireServiceSecurity, createEnvSseTicketStore } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, postgresHealthCheck } from '@pipeline-builder/api-server';
import { createSoftDeletePurgeScheduler } from '@pipeline-builder/pipeline-data';

import { mountRoutes } from './app-routes.js';
import { attachmentService } from './services/attachment-service.js';
import { getAuditClient } from './services/audit.js';
import { messageService } from './services/message-service.js';

const logger = createLogger('message');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({ checkDependencies: postgresHealthCheck });

// Forward denied (non-GET) requests to the shared authz.denied audit sink.
wireServiceSecurity('message', getAuditClient);

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- SSE ticket store ---------------------------------------------------------
// Short-lived, single-use tickets so JWTs never appear in query strings / logs.
// Redis-backed when configured so a ticket minted on one replica is redeemable
// on another (multi-replica correctness); falls back to in-memory single-process.

/** Hard cap on tickets minted per TTL window across all orgs — bounds abuse.
 *  Override via SSE_MAX_TOTAL_TICKETS. */
const MAX_TOTAL_TICKETS = parseInt(process.env.SSE_MAX_TOTAL_TICKETS || '1000', 10);
/** Per-org cap — prevents a single tenant from saturating the store.
 *  Override via SSE_MAX_TICKETS_PER_ORG. */
const MAX_TICKETS_PER_ORG = parseInt(process.env.SSE_MAX_TICKETS_PER_ORG || '10', 10);

const ticketStore = createEnvSseTicketStore({
  ttlMs: SSE_TICKET_TTL_MS,
  maxTotal: MAX_TOTAL_TICKETS,
  maxPerOrg: MAX_TICKETS_PER_ORG,
});

mountRoutes(app, { quotaService, sseManager, ticketStore });

logger.info('All /messages routes registered');

// Retention purge: hard-delete message tombstones past their purge_after
// deadline. Leader-locked + sysadmin-scoped inside the sweep. Opt out with
// SOFT_DELETE_PURGE_ENABLED=false.
const purgeScheduler = createSoftDeletePurgeScheduler({
  service: 'message',
  entities: [
    { name: 'message', purgeExpired: (now, limit) => messageService.purgeExpired(now, limit) },
    // Reap abandoned PENDING attachments (uploaded but never linked to a sent
    // message) + their blobs. Same leader-locked, sysadmin-scoped sweep.
    { name: 'message_attachment_pending', purgeExpired: (now, limit) => attachmentService.purgePending(now, limit) },
  ],
});
purgeScheduler?.start();

runServer(app, {
  name: 'Message Service',
  sseManager,
  onShutdown: async () => {
    ticketStore.stop();
    purgeScheduler?.stop();
  },
});
