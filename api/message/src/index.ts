// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';

import { createLogger, requireAuth, createQuotaService, sendSuccess, sendError, ErrorCode, SSE_TICKET_TTL_MS, setAuthzDenialAuditor } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, postgresHealthCheck } from '@pipeline-builder/api-server';
import type { Request, Response } from 'express';

import { createCreateMessageRoutes } from './routes/create-message.js';
import { createDeleteMessageRoutes } from './routes/delete-message.js';
import { createReadMessageRoutes } from './routes/read-messages.js';
import { createUpdateMessageRoutes } from './routes/update-message.js';
import { getAuditClient } from './services/audit.js';

const logger = createLogger('message');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({ checkDependencies: postgresHealthCheck });

// -- Failed-authorization auditor (#5) ----------------------------------------
// Forward denials from the shared requirePermission / requireSystemAdmin gate to
// platform's audit ingest as `authz.denied`, best-effort (the gate try/catches).
setAuthzDenialAuditor((info) => getAuditClient().record({
  action: 'authz.denied',
  actorId: info.actorId ?? 'anonymous',
  actorEmail: info.actorEmail,
  orgId: info.orgId,
  outcome: 'failure',
  details: { method: info.method, path: info.path, required: info.required },
}, 'message'));

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- SSE ticket store ---------------------------------------------------------
// Short-lived, single-use tickets so JWTs never appear in query strings / logs.

/** Ticket TTL — see api-core `SSE_TICKET_TTL_MS` (enough for the client to open the EventSource). */
const TICKET_TTL_MS = SSE_TICKET_TTL_MS;

/** Hard cap on total live tickets across the process — bounds memory under abuse.
 *  Override via SSE_MAX_TOTAL_TICKETS. */
const MAX_TOTAL_TICKETS = parseInt(process.env.SSE_MAX_TOTAL_TICKETS || '1000', 10);
/** Per-org cap — prevents a single tenant from saturating the table.
 *  Override via SSE_MAX_TICKETS_PER_ORG. */
const MAX_TICKETS_PER_ORG = parseInt(process.env.SSE_MAX_TICKETS_PER_ORG || '10', 10);

interface SseTicket { orgId: string; expiresAt: number }
const ticketStore = new Map<string, SseTicket>();

function countLiveTicketsForOrg(orgId: string, now: number): number {
  let count = 0;
  for (const ticket of ticketStore.values()) {
    if (ticket.orgId === orgId && ticket.expiresAt > now) count++;
  }
  return count;
}

// Periodic cleanup of expired tickets
const ticketCleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, ticket] of ticketStore) {
    if (now > ticket.expiresAt) ticketStore.delete(id);
  }
}, TICKET_TTL_MS);
ticketCleanup.unref();

// POST /messages/notifications/ticket — exchange JWT for a single-use SSE ticket
app.post(
  '/messages/notifications/ticket',
  requireAuth,
  (req: Request, res: Response) => {
    const orgId = req.user?.organizationId?.toLowerCase();
    if (!orgId) {
      return sendError(res, 400, 'Token missing organization', ErrorCode.VALIDATION_ERROR);
    }

    const now = Date.now();
    if (ticketStore.size >= MAX_TOTAL_TICKETS) {
      return sendError(res, 503, 'Notification subsystem at capacity', ErrorCode.QUOTA_EXCEEDED);
    }
    if (countLiveTicketsForOrg(orgId, now) >= MAX_TICKETS_PER_ORG) {
      return sendError(res, 429, 'Too many notification tickets issued', ErrorCode.QUOTA_EXCEEDED);
    }

    const ticketId = crypto.randomBytes(24).toString('base64url');
    ticketStore.set(ticketId, { orgId, expiresAt: now + TICKET_TTL_MS });
    return sendSuccess(res, 200, { ticket: ticketId });
  },
);

// GET /messages/notifications?ticket=<ticket> — SSE endpoint using ticket auth
app.get(
  '/messages/notifications',
  (req: Request, res: Response) => {
    const ticketId = req.query.ticket as string | undefined;
    if (!ticketId) {
      sendError(res, 401, 'Missing ticket parameter', ErrorCode.UNAUTHORIZED);
      return;
    }

    const ticket = ticketStore.get(ticketId);
    ticketStore.delete(ticketId); // Single use — consume immediately

    if (!ticket || Date.now() > ticket.expiresAt) {
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
app.use('/messages', createReadMessageRoutes(quotaService));
app.use('/messages', createCreateMessageRoutes(sseManager));
app.use('/messages', createUpdateMessageRoutes(sseManager));
app.use('/messages', createDeleteMessageRoutes(sseManager));

logger.info('All /messages routes registered');

runServer(app, {
  name: 'Message Service',
  sseManager,
  onShutdown: async () => {
    clearInterval(ticketCleanup);
  },
});
