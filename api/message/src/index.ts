// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, requirePermission, requireStepUp, createQuotaService, SSE_TICKET_TTL_MS, wireServiceSecurity, createEnvSseTicketStore } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, createAuthenticatedWithOrgRoute, postgresHealthCheck, registerSseTicketChannel } from '@pipeline-builder/api-server';
import { createSoftDeletePurgeScheduler } from '@pipeline-builder/pipeline-data';

import { createAttachmentRoutes } from './routes/attachment-routes.js';
import { createCreateMessageRoutes } from './routes/create-message.js';
import { createDeleteMessageRoutes } from './routes/delete-message.js';
import { createInternalNotifyRoutes } from './routes/internal-notify.js';
import { createInternalOrgPurgeRoutes } from './routes/internal-org-purge.js';
import { createPurgeMessageRoutes } from './routes/purge-message.js';
import { createReadMessageRoutes } from './routes/read-messages.js';
import { createRestoreMessageRoutes } from './routes/restore-message.js';
import { createUpdateMessageRoutes } from './routes/update-message.js';
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

// Per-org notification SSE channel via the shared helper (POST …/ticket exchanges
// the JWT for a single-use org-bound ticket; GET …/notifications redeems it and
// attaches an EventSource keyed by the org). The reporting execution-status
// channel uses the same helper.
registerSseTicketChannel(app, {
  ticketPath: '/messages/notifications/ticket',
  streamPath: '/messages/notifications',
  ticketStore,
  sseManager,
  label: 'notification',
});

// -- /messages routes ---------------------------------------------------------
// Each route attaches its own auth/quota middleware so that mounting these
// at a shared prefix never causes middleware to bleed across verbs.
// Attachment upload/download — mounted BEFORE the read routes so the literal
// `/attachments` + `/attachments/:id` paths resolve here and aren't swallowed by
// the read router's `/:id` matcher. Each route owns its auth (messages:write to
// upload, messages:read to download).
app.use('/messages', createAttachmentRoutes(quotaService));
app.use('/messages', createReadMessageRoutes(quotaService));
app.use('/messages', createCreateMessageRoutes(sseManager));
app.use('/messages', createUpdateMessageRoutes(sseManager));
app.use('/messages', createDeleteMessageRoutes(sseManager));

// Internal org-purge (service-to-service): the platform cascade calls
// DELETE /messages/internal/org/:orgId/attachments to reclaim the org's MinIO
// blobs. Its own requireAuth + requireServicePrincipal gate it — no user chain.
// Internal notify (service-to-service): a trusted platform service posts a
// SYSTEM-authored in-app message + SSE ping to a recipient org/user (domain-join
// notifications). Its own requireAuth + requireServicePrincipal gate it.
//
// Both MUST be mounted BEFORE the step-up mount below. That mount applies its
// chain as prefix middleware to every /messages request that reaches it, so an
// internal route mounted after it inherited `requirePermission('messages:write')`
// — which a service token (no permission claims) fails with 403 — plus a second
// pass through the idempotency middleware.
app.use('/messages', createInternalOrgPurgeRoutes());
app.use('/messages', createInternalNotifyRoutes(sseManager));

// -- Purge + Restore routes — auth + orgId + messages:write + step-up --------
// Both are permanently-consequential soft-delete operations and BOTH require a
// step-up (password re-verify) beyond messages:write:
//   - Restore: undo a soft-delete within the retention window.
//   - Purge:   permanent hard-delete of an already soft-deleted tombstone.
// They share ONE mount so each request clears the chain exactly once.
// `requireStepUp` consumes the step-up token's `jti` a single time, so two
// separate step-up mounts made every request for the SECOND router fall through
// the first mount's step-up (consuming the jti) and then 401 as STEP_UP_REPLAY
// at its own. The same stacking ran the idempotency middleware twice with the
// same key, 409'ing any request that sent an Idempotency-Key. Mounted LAST so
// no other /messages route falls through this chain.
app.use('/messages', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), requireStepUp, createRestoreMessageRoutes(), createPurgeMessageRoutes());

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
