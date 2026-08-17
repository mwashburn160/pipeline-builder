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
import { withRoute, createAuthenticatedWithOrgRoute, incCounter, rateLimitByOrg } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import { schema } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { enrichOneWithOrgNames } from '../helpers/org-names.js';
import { isRecipientReachable, isTargetUserReachable } from '../helpers/org-reachability.js';
import { attachmentService } from '../services/attachment-service.js';
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
/** Per-org send limiter — a single org can't flood messages/replies (each one
 *  fans out over SSE + writes rows). Shared across send + reply. Env-overridable.
 *  Verified service principals are exempt; unauthenticated falls back to per-IP. */
const sendLimiter = rateLimitByOrg({
  name: 'message-send',
  max: Math.max(1, Number.parseInt(process.env.MESSAGE_SEND_RATE_MAX ?? '60', 10) || 60),
  windowMs: Math.max(1000, Number.parseInt(process.env.MESSAGE_SEND_RATE_WINDOW_MS ?? '60000', 10) || 60000),
  message: 'Too many messages sent, please slow down.',
});

export function createCreateMessageRoutes(sseManager: SSEManager): Router {
  const router = Router();

  // POST /messages — Create new message
  router.post('/', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), sendLimiter, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    // Validate request body with Zod schema
    const validation = validateBody(req, MessageCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { recipientOrgId: rawRecipientOrgId, recipientUserId, messageType, subject, content, priority, channel, attachmentIds } = validation.value;

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

    // Converse of the announcement guard: '*' is a BROADCAST recipient and is
    // reserved for announcements. A conversation must never target '*' — for
    // ALL callers, including sysadmins/service-principals (who bypass the
    // reachability gate below). Without this, a '*'-recipient conversation would
    // land in every org's inbox (buildMessageConditions surfaces recipient='*'
    // to everyone) — an un-audited broadcast masquerading as a 1:1 message. The
    // reachability gate never catches it because '*' short-circuits reachability
    // and sysadmins/service-principals skip the gate entirely.
    if (messageType === 'conversation' && recipientOrgId === '*') {
      return sendBadRequest(res, 'Conversations cannot use "*" as recipientOrgId; "*" is reserved for announcement broadcasts', ErrorCode.VALIDATION_ERROR);
    }

    // Per-user targeting is a CONVERSATION-only, concrete-recipient feature.
    // It is meaningless on an announcement (an org-wide '*' broadcast), so reject
    // rather than silently drop it — a mis-built client must not believe it sent
    // a private, single-user message when it actually broadcast org-wide.
    if (recipientUserId && (messageType === 'announcement' || recipientOrgId === '*')) {
      return sendBadRequest(res, 'recipientUserId is only valid on a conversation to a specific organization', ErrorCode.VALIDATION_ERROR);
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

    // Per-user target must be an ACTIVE member of the recipient org, else the DM
    // black-holes (viewer-scoping surfaces it to that user alone; a non-member
    // is nobody). Reject the mistake up front. Fail-open on an indeterminate
    // platform lookup — this is a correctness guard, not an authz boundary
    // (the recipient still can't read anything they're not scoped for).
    if (recipientUserId && !(await isTargetUserReachable(recipientOrgId, recipientUserId))) {
      ctx.log('WARN', 'Blocked DM to non-member recipient user', { recipientOrgId });
      return sendBadRequest(res, 'recipientUserId is not an active member of the recipient organization', ErrorCode.VALIDATION_ERROR);
    }

    ctx.log('INFO', 'Creating message', { messageType, recipientOrgId, subject });

    const messageData: MessageInsert = {
      orgId,
      recipientOrgId: recipientOrgId.toLowerCase() === '*' ? '*' : recipientOrgId.toLowerCase(),
      // Per-user target (null = whole recipient org). Guarded above to be absent
      // on announcements / '*' broadcasts.
      recipientUserId: recipientUserId ?? null,
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

    // Link any pre-uploaded attachments to this message. Only the caller's own
    // still-pending uploads link (enforced in the service); a mismatch means the
    // client sent a bogus/foreign/already-linked id — logged, non-fatal (the
    // message stands with whatever validly linked).
    if (attachmentIds?.length) {
      const linked = await attachmentService.linkToMessage(attachmentIds, message.id, orgId, userId);
      if (linked.length !== attachmentIds.length) {
        ctx.log('WARN', 'Some attachments did not link', { requested: attachmentIds.length, linked: linked.length });
      }
    }

    ctx.log('COMPLETED', 'Message created', { id: message.id, messageType });

    // Domain metric — a message was created. Tagged by action only to keep
    // label cardinality bounded (no orgId/messageId).
    incCounter('message_events_total', { action: 'created' });

    // Push SSE notification to recipient
    try {
      // The SSE fan-out is ORG-scoped (no per-user channel), so every member of
      // the recipient org receives this event. For a per-user targeted message
      // that means the `subject` would leak to members who cannot read the
      // message — so redact it (and mark the target) when targeted. The client
      // shows a generic "new message" ping and refetches; server-side visibility
      // (findVisibleById / viewer-scoped inbox) still gates the actual content.
      const notificationData = {
        action: 'NEW_MESSAGE' as const,
        messageId: message.id,
        // Redact the subject for a targeted message — the SSE fan-out is
        // org-wide, so members who can't read it must not see its subject. We
        // also DON'T include recipientUserId: it would tell every org member
        // WHICH user was targeted. The client just refetches; server-side
        // visibility gates who actually sees the message.
        subject: recipientUserId ? undefined : subject,
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

    return sendSuccess(res, 201, await enrichOneWithOrgNames(message), 'Message created successfully');
  }));

  // POST /messages/:id/reply — Reply to a thread
  router.post('/:id/reply', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), sendLimiter, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    // Validate request body with Zod schema
    const validation = validateBody(req, MessageReplySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { content, attachmentIds } = validation.value;

    // Find the root message, VIEWER-SCOPED: if the root is targeted at a specific
    // user, only that user (and the sender org / system org) can load it — so a
    // non-target member of the recipient org can't reply into a private thread.
    const rootMessage = await messageService.findVisibleById(id, orgId, userId);
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

    // A reply is ALWAYS a conversation, never an announcement — even when the
    // root is an announcement (a member replying to a broadcast opens a 1:1
    // support thread to the system org). Copying rootMessage.messageType here
    // persisted `announcement`-typed rows authored by non-sysadmins, polluting
    // messageType filters and the announcements feed. Pin replies to conversation.
    const replyMessageType = 'conversation' as const;

    // Keep a per-user targeted thread private: when the reply is addressed BACK
    // to the org that held the targeted user (rootMessage.recipientOrgId), carry
    // the target forward so only that user sees it. Replies toward the sender org
    // stay org-wide (the sender side was always org-wide). Null-safe: an untargeted
    // root yields null on both branches (today's behavior).
    const replyRecipientUserId =
      replyRecipientOrgId.toLowerCase() === rootMessage.recipientOrgId.toLowerCase()
        ? rootMessage.recipientUserId ?? null
        : null;

    const replyData: MessageInsert = {
      orgId,
      threadId: id,
      recipientOrgId: replyRecipientOrgId,
      recipientUserId: replyRecipientUserId,
      messageType: replyMessageType,
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

    if (attachmentIds?.length) {
      const linked = await attachmentService.linkToMessage(attachmentIds, reply.id, orgId, userId);
      if (linked.length !== attachmentIds.length) {
        ctx.log('WARN', 'Some reply attachments did not link', { requested: attachmentIds.length, linked: linked.length });
      }
    }

    ctx.log('COMPLETED', 'Reply created', { id: reply.id, threadId: id });

    // Domain metric — a reply is a created message row too.
    incCounter('message_events_total', { action: 'created' });

    // Push SSE notification to the reply recipient
    try {
      sseManager.send(replyRecipientOrgId.toLowerCase(), 'MESSAGE', 'New reply', {
        action: 'NEW_MESSAGE' as const,
        messageId: reply.id,
        threadId: id,
        // Same redaction as the create path: a targeted reply's subject must not
        // reach the whole recipient org via the org-wide SSE fan-out.
        subject: replyRecipientUserId ? undefined : rootMessage.subject,
        senderOrgId: orgId,
        messageType: replyMessageType,
      });
    } catch (err) {
      ctx.log('WARN', 'Failed to send SSE notification', { error: errorMessage(err) });
    }

    return sendSuccess(res, 201, await enrichOneWithOrgNames(reply), 'Reply sent successfully');
  }));

  return router;
}
