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
  isSystemAdmin,
  isServicePrincipal,
  requirePermission,
  validateBody,
  MessageCreateSchema,
  MessageReplySchema,
  resolveRecipientAlias,
  sendEntityNotFound,
  errorMessage,
} from '@pipeline-builder/api-core';
import { withRoute, createAuthenticatedWithOrgRoute } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import { schema } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { isRecipientReachable } from '../helpers/org-reachability.js';
import { getAuditClient } from '../services/audit.js';
import { messageService } from '../services/message-service.js';

type MessageInsert = typeof schema.message.$inferInsert;

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
  router.post('/', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    // Validate request body with Zod schema
    const validation = validateBody(req, MessageCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { recipientOrgId: rawRecipientOrgId, messageType, subject, content, priority, channel } = validation.value;

    // Resolve email-like aliases (e.g., support@pipeline-builder -> system)
    const { resolvedOrgId: recipientOrgId, wasAlias, originalValue } = resolveRecipientAlias(rawRecipientOrgId);
    if (wasAlias) {
      ctx.log('INFO', 'Resolved recipient alias', { alias: originalValue, resolvedTo: recipientOrgId });
    }

    // Announcements are sysadmin broadcasts; only Pipeline Builder
    // operators may send them, regardless of which org they're currently
    // scoped to.
    if (messageType === 'announcement' && !isSystemAdmin(req)) {
      return sendError(res, 403, 'Only sysadmins can create announcements', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    // Broadcast announcements must use '*' as recipient
    if (messageType === 'announcement' && recipientOrgId !== '*') {
      return sendBadRequest(res, 'Announcements must use "*" as recipientOrgId for broadcast', ErrorCode.VALIDATION_ERROR);
    }

    // Conversations: a concrete recipient is required.
    if (messageType === 'conversation' && !recipientOrgId) {
      return sendBadRequest(res, 'recipientOrgId is required for conversations', ErrorCode.VALIDATION_ERROR);
    }

    // Cross-tenant send gate. A non-sysadmin member may only start a
    // conversation with an org they could also RECEIVE from — mirroring the
    // read-visibility model in `buildMessageConditions`. Reachable recipients:
    //   - the caller's OWN org;
    //   - the SYSTEM support inbox (support channel — always reachable);
    //   - an org within the caller's ACCOUNT (same root org → team hierarchy).
    // Without this, any member could drop an unsolicited message into an
    // arbitrary tenant's inbox (the recipient can read it). Sysadmins and
    // service principals (support-replies-out, internal automation) may target
    // any org and bypass the gate. Announcements are '*' broadcasts already
    // gated to sysadmins above, so they never reach here as a concrete org.
    if (
      messageType === 'conversation'
      && !isSystemAdmin(req)
      && !isServicePrincipal(req)
      && !(await isRecipientReachable(orgId, recipientOrgId))
    ) {
      ctx.log('WARN', 'Blocked cross-tenant message recipient', { recipientOrgId });
      return sendError(
        res,
        403,
        'You cannot send a message to that organization',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    ctx.log('INFO', 'Creating message', { messageType, recipientOrgId, subject });

    const messageData: MessageInsert = {
      orgId,
      recipientOrgId: recipientOrgId.toLowerCase() === '*' ? '*' : recipientOrgId.toLowerCase(),
      messageType,
      channel: channel?.toLowerCase() ?? null,
      subject,
      content,
      priority,
      createdBy: userId,
      updatedBy: userId,
      accessModifier: AccessModifier.PRIVATE,
    };

    const message = await messageService.create(messageData, userId);

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
      ctx.log('WARN', 'Failed to send SSE notification', { error: errorMessage(err) });
    }

    // Audit ONLY admin broadcasts. Announcements are sysadmin org-wide
    // broadcasts (gated above to messageType==='announcement' + recipient '*');
    // 1:1 conversations/replies are intentionally NOT audited — they are noisy
    // and would pull private message content into the trail. `details` carries
    // SAFE METADATA ONLY (subject/type/recipient scope) — never the body.
    // Fire-and-forget: RemoteAuditClient.record never throws and is not awaited.
    if (messageType === 'announcement') {
      getAuditClient().record({
        action: 'message.announcement.create',
        actorId: req.user?.sub ?? userId ?? 'system',
        orgId,
        targetId: message.id,
        details: {
          subject,
          messageType,
          recipientScope: 'org-wide',
        },
      }, 'message');
    }

    return sendSuccess(res, 201, message, 'Message created successfully');
  }));

  // POST /messages/:id/reply — Reply to a thread
  router.post('/:id/reply', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
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

    ctx.log('INFO', 'Replying to thread', { threadId: id });

    // Determine the recipient for the reply
    let replyRecipientOrgId: string;
    if (isSystem) {
      // System org replying — send to the original sender
      replyRecipientOrgId = rootMessage.orgId;
    } else if (isBroadcast) {
      // Replying to announcement — send to the system org
      replyRecipientOrgId = SYSTEM_ORG_ID;
    } else {
      // Regular org replying — send to the other party
      replyRecipientOrgId = isSender ? rootMessage.recipientOrgId : rootMessage.orgId;
    }

    const replyData: MessageInsert = {
      orgId,
      threadId: id,
      recipientOrgId: replyRecipientOrgId,
      messageType: rootMessage.messageType,
      // Replies inherit the root message's channel so the thread stays
      // in one bucket — system-org filtering by channel sees the whole
      // conversation, not just the first message.
      channel: rootMessage.channel?.toLowerCase() ?? null,
      subject: rootMessage.subject,
      content,
      priority: rootMessage.priority,
      createdBy: userId,
      updatedBy: userId,
      accessModifier: AccessModifier.PRIVATE,
    };

    const reply = await messageService.create(replyData, userId);

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
      ctx.log('WARN', 'Failed to send SSE notification', { error: errorMessage(err) });
    }

    return sendSuccess(res, 201, reply, 'Reply sent successfully');
  }));

  return router;
}
