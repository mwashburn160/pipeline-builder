// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  AccessModifier,
  SYSTEM_ORG_ID,
  sendError,
  sendBadRequest,
  sendSuccess,
  ErrorCode,
  getParam,
  validateBody,
  MessageCreateSchema,
  MessageReplySchema,
  createLogger,
  resolveRecipientAlias,
  sendEntityNotFound,
  errorMessage,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import { schema } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { messageService } from '../services/message-service';

type MessageInsert = typeof schema.message.$inferInsert;

const logger = createLogger('create-message');

/**
 * Create the message creation router (authenticated).
 *
 * Registers:
 * - POST /messages           -- create a new announcement or conversation
 * - POST /messages/:id/reply -- reply to an existing thread
 * @param sseManager - SSE manager for pushing real-time notifications
 * @returns Express Router
 */
export function createCreateMessageRoutes(sseManager: SSEManager): Router {
  const router = Router();

  // POST /messages — Create new message
  router.post('/', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    // Validate request body with Zod schema
    const validation = validateBody(req, MessageCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { recipientOrgId: rawRecipientOrgId, messageType, subject, content, priority } = validation.value;

    // Resolve email-like aliases (e.g., support@pipeline-builder -> system)
    const { resolvedOrgId: recipientOrgId, wasAlias, originalValue } = resolveRecipientAlias(rawRecipientOrgId);
    if (wasAlias) {
      ctx.log('INFO', 'Resolved recipient alias', { alias: originalValue, resolvedTo: recipientOrgId });
    }

    // Business logic: announcements can only be created by system org
    if (messageType === 'announcement' && orgId !== SYSTEM_ORG_ID) {
      return sendError(res, 403, 'Only system org can create announcements', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    // Broadcast announcements must use '*' as recipient
    if (messageType === 'announcement' && recipientOrgId !== '*') {
      return sendBadRequest(res, 'Announcements must use "*" as recipientOrgId for broadcast', ErrorCode.VALIDATION_ERROR);
    }

    // Conversations: non-system orgs can only message system org
    if (messageType === 'conversation' && orgId !== SYSTEM_ORG_ID && recipientOrgId.toLowerCase() !== SYSTEM_ORG_ID) {
      return sendError(res, 403, 'Organizations can only start conversations with the system org', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    ctx.log('INFO', 'Creating message', { messageType, recipientOrgId, subject });

    const messageData: Partial<MessageInsert> = {
      orgId,
      recipientOrgId: recipientOrgId.toLowerCase() === '*' ? '*' : recipientOrgId.toLowerCase(),
      messageType,
      subject,
      content,
      priority,
      createdBy: userId,
      updatedBy: userId,
      accessModifier: AccessModifier.PRIVATE,
    };

    const message = await messageService.create(messageData as MessageInsert, userId);

    ctx.log('COMPLETED', 'Message created', { id: message.id, messageType });

    // Push SSE notification to recipient
    try {
      const notificationData = {
        action: 'NEW_MESSAGE' as const,
        messageId: message.id,
        subject,
        senderOrgId: orgId,
        messageType,
      };

      if (recipientOrgId.toLowerCase() === '*') {
        sseManager.broadcast('MESSAGE', 'New announcement', notificationData);
      } else {
        sseManager.send(recipientOrgId.toLowerCase(), 'MESSAGE', 'New message', notificationData);
      }
    } catch (err) {
      logger.warn('Failed to send SSE notification', { error: errorMessage(err) });
    }

    return sendSuccess(res, 201, message, 'Message created successfully');
  }));

  // POST /messages/:id/reply — Reply to a thread
  router.post('/:id/reply', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    // Validate request body with Zod schema
    const validation = validateBody(req, MessageReplySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { content } = validation.value;

    // Find the root message
    const rootMessage = await messageService.findById(id, orgId);
    if (!rootMessage) {
      return sendEntityNotFound(res, 'Message');
    }

    // Thread-root invariant: the target must be a root message (not itself a
    // reply). Allowing replies-to-replies creates orphan grandchildren — the
    // thread reader walks `threadId === root.id`, so a deeper hierarchy is
    // invisible from the UI. Force the client to reply to the root.
    if (rootMessage.threadId) {
      return sendBadRequest(
        res,
        'Cannot reply to a reply. Reply to the root message of the thread instead.',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // Validate the user can reply (must be sender org, recipient org, or system org)
    const isSender = rootMessage.orgId.toLowerCase() === orgId;
    const isRecipient = rootMessage.recipientOrgId.toLowerCase() === orgId;
    const isBroadcast = rootMessage.recipientOrgId === '*';
    const isSystem = orgId === SYSTEM_ORG_ID;

    if (!isSender && !isRecipient && !isBroadcast && !isSystem) {
      return sendError(res, 403, 'You are not a participant in this conversation', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    // Validate reply message type matches root message type
    if (req.body.messageType && req.body.messageType !== rootMessage.messageType) {
      return sendBadRequest(res, `Reply messageType must match root message type '${rootMessage.messageType}'`, ErrorCode.VALIDATION_ERROR);
    }

    ctx.log('INFO', 'Replying to thread', { threadId: id });

    // Determine the recipient for the reply
    let replyRecipientOrgId: string;
    if (isSystem) {
      // System org replying — send to the original sender
      replyRecipientOrgId = rootMessage.orgId;
    } else if (isBroadcast) {
      // Replying to announcement — send to system
      replyRecipientOrgId = 'system';
    } else {
      // Regular org replying — send to the other party
      replyRecipientOrgId = isSender ? rootMessage.recipientOrgId : rootMessage.orgId;
    }

    const replyData: Partial<MessageInsert> = {
      orgId,
      threadId: id,
      recipientOrgId: replyRecipientOrgId,
      messageType: rootMessage.messageType,
      subject: rootMessage.subject,
      content,
      priority: rootMessage.priority,
      createdBy: userId,
      updatedBy: userId,
      accessModifier: AccessModifier.PRIVATE,
    };

    const reply = await messageService.create(replyData as MessageInsert, userId);

    ctx.log('COMPLETED', 'Reply created', { id: reply.id, threadId: id });

    // Push SSE notification to the reply recipient
    try {
      sseManager.send(replyRecipientOrgId.toLowerCase(), 'MESSAGE', 'New reply', {
        action: 'NEW_MESSAGE' as const,
        messageId: reply.id,
        threadId: id,
        subject: rootMessage.subject,
        senderOrgId: orgId,
        messageType: rootMessage.messageType,
      });
    } catch (err) {
      logger.warn('Failed to send SSE notification', { error: errorMessage(err) });
    }

    return sendSuccess(res, 201, reply, 'Reply sent successfully');
  }));

  return router;
}
