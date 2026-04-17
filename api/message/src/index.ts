// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';

import { createLogger, requireAuth, createQuotaService, sendSuccess, sendError, ErrorCode, SSE_TICKET_TTL_MS } from '@pipeline-builder/api-core';
import { createApp, startServer, createProtectedRoute, createAuthenticatedWithOrgRoute, attachRequestContext, createWSManager } from '@pipeline-builder/api-server';
import { db } from '@pipeline-builder/pipeline-core';
import { sql } from 'drizzle-orm';
import { Request, Response } from 'express';
import { WebSocketServer } from 'ws';

import { createCreateMessageRoutes } from './routes/create-message';
import { createDeleteMessageRoutes } from './routes/delete-message';
import { createReadMessageRoutes } from './routes/read-messages';
import { createUpdateMessageRoutes } from './routes/update-message';

const logger = createLogger('message');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({
  checkDependencies: async () => {
    try { await db.execute(sql`SELECT 1`); return { postgres: 'connected' as const }; } catch { return { postgres: 'unknown' as const }; }
  },
});

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- SSE ticket store ---------------------------------------------------------
// Short-lived, single-use tickets so JWTs never appear in query strings / logs.

/** Ticket TTL in ms (30 seconds — enough for the client to open the EventSource). */
const TICKET_TTL_MS = SSE_TICKET_TTL_MS;

interface SseTicket { orgId: string; expiresAt: number }
const ticketStore = new Map<string, SseTicket>();

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

    const ticketId = crypto.randomBytes(24).toString('base64url');
    ticketStore.set(ticketId, { orgId, expiresAt: Date.now() + TICKET_TTL_MS });
    return sendSuccess(res, 200, { ticket: ticketId });
  },
);

// GET /messages/notifications?ticket=<ticket> — SSE endpoint using ticket auth
app.get(
  '/messages/notifications',
  (req: Request, res: Response) => {
    const ticketId = req.query.ticket as string | undefined;
    if (!ticketId) {
      res.status(401).json({ success: false, message: 'Missing ticket parameter' });
      return;
    }

    const ticket = ticketStore.get(ticketId);
    ticketStore.delete(ticketId); // Single use — consume immediately

    if (!ticket || Date.now() > ticket.expiresAt) {
      res.status(401).json({ success: false, message: 'Invalid or expired ticket' });
      return;
    }

    const { orgId } = ticket;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const added = sseManager.addClient(orgId, res);
    if (!added) {
      res.status(429).end('Too many notification connections');
      return;
    }

    logger.info('SSE notification client connected', { orgId });
  },
);

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/messages', ...createProtectedRoute(quotaService, 'apiCalls'), createReadMessageRoutes(quotaService));

// -- Create routes — auth + orgId (no quota check on messages) ----------------
app.use('/messages', ...createAuthenticatedWithOrgRoute(), createCreateMessageRoutes(sseManager));

// -- Update routes (mark read) — auth + orgId ---------------------------------
app.use('/messages', ...createAuthenticatedWithOrgRoute(), createUpdateMessageRoutes(sseManager));

// -- Delete route — auth + orgId (permission checked in handler) --------------
app.use('/messages', ...createAuthenticatedWithOrgRoute(), createDeleteMessageRoutes(sseManager));

logger.info('All /messages routes registered');

// -- WebSocket server for bidirectional real-time communication ---------------

const wsManager = createWSManager({ maxClientsPerOrg: 50 });
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, orgId: string) => {
  const clientId = crypto.randomBytes(8).toString('hex');
  const client = {
    id: clientId,
    orgId,
    send: (data: string) => { if (ws.readyState === ws.OPEN) ws.send(data); },
    close: () => ws.close(),
  };

  if (!wsManager.addClient(client)) {
    ws.close(1013, 'Max connections reached');
    return;
  }

  ws.on('message', (raw) => wsManager.handleMessage(client, String(raw)));
  ws.on('close', () => wsManager.removeClient(client));
  ws.on('error', () => wsManager.removeClient(client));

  // Send connected confirmation
  ws.send(JSON.stringify({ type: 'connected', clientId, orgId }));
});

// Start server and wire WebSocket upgrade
startServer(app, {
  name: 'Message Service',
  sseManager,
  onShutdown: async () => {
    clearInterval(ticketCleanup);
    wss.close();
  },
}).then(({ server }) => {
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const orgId = url.searchParams.get('orgId');
      if (!orgId) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, orgId);
      });
    } else {
      socket.destroy();
    }
  });
  logger.info('WebSocket server attached at /ws');
}).catch((err) => {
  logger.error('Failed to start server', { error: err });
  process.exit(1);
});
