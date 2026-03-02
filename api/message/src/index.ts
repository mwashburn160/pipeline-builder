/**
 * @module message
 * @description Message microservice for internal org-to-system-org communication.
 *
 * Routes mounted under /messages:
 *
 *   GET    /messages/notifications     — SSE endpoint for real-time message notifications
 *   GET    /messages              — list inbox with pagination
 *   GET    /messages/announcements — list announcements
 *   GET    /messages/conversations — list conversations
 *   GET    /messages/unread/count  — get unread message count
 *   GET    /messages/:id           — get message by ID
 *   GET    /messages/:id/thread    — get all messages in a thread
 *   POST   /messages               — create new message or announcement
 *   POST   /messages/:id/reply     — reply to a thread
 *   PUT    /messages/:id/read      — mark message as read
 *   PUT    /messages/:id/thread/read — mark thread as read
 *   DELETE /messages/:id           — soft delete a message
 */

import { createLogger, requireAuth } from '@mwashburn160/api-core';
import { createApp, runServer, createQuotaService, createProtectedRoute, createAuthenticatedWithOrgRoute, attachRequestContext } from '@mwashburn160/api-server';
import { Request, Response, NextFunction } from 'express';

import { createCreateMessageRoutes } from './routes/create-message';
import { createDeleteMessageRoutes } from './routes/delete-message';
import { createReadMessageRoutes } from './routes/read-messages';
import { createUpdateMessageRoutes } from './routes/update-message';

const logger = createLogger('message');
const quotaService = createQuotaService();
const { app, sseManager } = createApp();

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- SSE notification endpoint (auth via query param, before protected routes) -
// Injects query token into Authorization header so requireAuth can verify it,
// then registers the client with SSEManager keyed by orgId.
app.get(
  '/messages/notifications',
  // Inject token from query param into Authorization header
  (req: Request, _res: Response, next: NextFunction) => {
    const token = req.query.token as string;
    if (token && !req.headers.authorization) {
      req.headers.authorization = `Bearer ${token}`;
    }
    next();
  },
  // Reuse existing JWT verification middleware
  requireAuth,
  // Set up SSE connection
  (req: Request, res: Response) => {
    const orgId = (req as any).user?.organizationId?.toLowerCase();
    if (!orgId) {
      res.status(400).json({ success: false, message: 'Token missing organization' });
      return;
    }

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

    logger.info(`SSE notification client connected for org ${orgId}`);
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

void runServer(app, { name: 'Message Service', sseManager });
