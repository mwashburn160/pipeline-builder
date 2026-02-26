/**
 * @module message
 * @description Message microservice for internal org-to-system-org communication.
 *
 * Routes mounted under /messages:
 *
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

import { createLogger } from '@mwashburn160/api-core';
import { createApp, runServer, createQuotaService, createProtectedRoute, createAuthenticatedWithOrgRoute, attachRequestContext } from '@mwashburn160/api-server';

import { createCreateMessageRoutes } from './routes/create-message';
import { createDeleteMessageRoutes } from './routes/delete-message';
import { createReadMessageRoutes } from './routes/read-messages';
import { createUpdateMessageRoutes } from './routes/update-message';

const logger = createLogger('message');
const quotaService = createQuotaService();
const { app, sseManager } = createApp();

// -- Attach request context to all requests -----------------------------------
app.use(attachRequestContext(sseManager));

// -- Read routes (list, find, get-by-id) — auth + orgId + apiCalls quota ------
app.use('/messages', ...createProtectedRoute(quotaService, 'apiCalls'), createReadMessageRoutes(quotaService));

// -- Create routes — auth + orgId (no quota check on messages) ----------------
app.use('/messages', ...createAuthenticatedWithOrgRoute(), createCreateMessageRoutes());

// -- Update routes (mark read) — auth + orgId ---------------------------------
app.use('/messages', ...createAuthenticatedWithOrgRoute(), createUpdateMessageRoutes());

// -- Delete route — auth + orgId (permission checked in handler) --------------
app.use('/messages', ...createAuthenticatedWithOrgRoute(), createDeleteMessageRoutes());

logger.info('All /messages routes registered');

void runServer(app, { name: 'Message Service', sseManager });
