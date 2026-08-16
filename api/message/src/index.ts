// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, requireAuth, requirePermission, requireStepUp, createQuotaService, sendSuccess, sendError, ErrorCode, SSE_TICKET_TTL_MS, wireServiceSecurity, createEnvSseTicketStore } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, createAuthenticatedWithOrgRoute, postgresHealthCheck } from '@pipeline-builder/api-server';
import { createSoftDeletePurgeScheduler } from '@pipeline-builder/pipeline-data';
import type { Request, Response } from 'express';

import { createAttachmentRoutes } from './routes/attachment-routes.js';
import { createCreateMessageRoutes } from './routes/create-message.js';
import { createDeleteMessageRoutes } from './routes/delete-message.js';
import { createInternalOrgPurgeRoutes } from './routes/internal-org-purge.js';
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

// POST /messages/notifications/ticket — exchange JWT for a single-use SSE ticket
app.post(
  '/messages/notifications/ticket',
  requireAuth,
  async (req: Request, res: Response) => {
    const orgId = req.user?.organizationId?.toLowerCase();
    if (!orgId) {
      return sendError(res, 400, 'Token missing organization', ErrorCode.VALIDATION_ERROR);
    }

    const result = await ticketStore.issue(orgId);
    if (!result.ok) {
      return result.reason === 'total'
        ? sendError(res, 503, 'Notification subsystem at capacity', ErrorCode.QUOTA_EXCEEDED)
        : sendError(res, 429, 'Too many notification tickets issued', ErrorCode.QUOTA_EXCEEDED);
    }
    return sendSuccess(res, 200, { ticket: result.ticket });
  },
);

// GET /messages/notifications?ticket=<ticket> — SSE endpoint using ticket auth
app.get(
  '/messages/notifications',
  async (req: Request, res: Response) => {
    const ticketId = req.query.ticket as string | undefined;
    if (!ticketId) {
      sendError(res, 401, 'Missing ticket parameter', ErrorCode.UNAUTHORIZED);
      return;
    }

    const ticket = await ticketStore.consume(ticketId); // atomic single-use
    if (!ticket) {
      sendError(res, 401, 'Invalid or expired ticket', ErrorCode.UNAUTHORIZED);
      return;
    }

    const { orgId } = ticket;

    // Reserve a connection slot BEFORE flushing SSE headers. Once
    // flushHeaders runs the response is committed at status 200, and any
    // subsequent attempt to set 429 is silently dropped by Node. The
    // previous order (set-headers → flush → addClient → 429-on-reject)
    // was broken: rejected connections returned 200 with a body that
    // looked like an error message.
    const added = sseManager.addClient(orgId, res);
    if (!added) {
      sendError(res, 429, 'Too many notification connections', ErrorCode.QUOTA_EXCEEDED);
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    logger.info('SSE notification client connected', { orgId });
  },
);

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

// -- Restore route — auth + orgId + messages:write + step-up ------------------
// Undo a soft-delete within the retention window; step-up-gated because it
// reverses a destructive action.
app.use('/messages', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), requireStepUp, createRestoreMessageRoutes());

// Internal org-purge (service-to-service): the platform cascade calls
// DELETE /messages/internal/org/:orgId/attachments to reclaim the org's MinIO
// blobs. Its own requireAuth + requireServicePrincipal gate it — no user chain.
app.use('/messages', createInternalOrgPurgeRoutes());

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
