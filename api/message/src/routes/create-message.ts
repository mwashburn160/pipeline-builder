// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_ORG_ID,
  sendError,
  sendBadRequest,
  sendSuccess,
  ErrorCode,
  getParam,
  getPrimarySupportAlias,
  isSystemAdmin,
  isServicePrincipal,
  requirePermission,
  validateBody,
  MessageCreateSchema,
  MessageReplySchema,
  audited,
  resolveRecipientAlias,
  sendEntityNotFound,
  errorMessage,
  actorId,
  envInt,
  recordAudit,
} from '@pipeline-builder/api-core';
import { withRoute, createAuthenticatedWithOrgRoute, incCounter, rateLimitByOrg } from '@pipeline-builder/api-server';
import type { RequestContext, SSEManager } from '@pipeline-builder/api-server';
import { schema } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import type { Response } from 'express';
import { notifyNewMessage, validateRecipient } from '../helpers/new-message.js';
import type { NewMessageNotification } from '../helpers/new-message.js';
import { enrichOneWithOrgNames } from '../helpers/org-names.js';
import { isRecipientReachable, isTargetUserReachable } from '../helpers/org-reachability.js';
import { attachmentService } from '../services/attachment-service.js';
import { messageService } from '../services/message-service.js';

type MessageInsert = typeof schema.message.$inferInsert;

/** Reserved channel every support-contact message is filed under, so system-org
 *  readers can filter the support desk out of the rest of their inbox. */
const SUPPORT_CHANNEL = 'support';
/** Per-org send limiter — a single org can't flood messages/replies (each one
 *  fans out over SSE + writes rows). Shared across send + reply. Env-overridable.
 *  Verified service principals are exempt; unauthenticated falls back to per-IP. */
const sendLimiter = rateLimitByOrg({
  name: 'message-send',
  max: envInt('MESSAGE_SEND_RATE_MAX', 60, { min: 1 }),
  windowMs: envInt('MESSAGE_SEND_RATE_WINDOW_MS', 60000, { min: 1000 }),
  message: 'Too many messages sent, please slow down.',
});

/** Everything the shared persist tail needs beyond the row itself. */
interface PersistOptions {
  /** The row to insert. */
  data: MessageInsert;
  /** Tenant + author, used for the attachment-link ownership check. */
  orgId: string;
  userId: string;
  /** Pre-uploaded attachment ids the client asked to attach, if any. */
  attachmentIds?: string[];
  /** WARN line when fewer attachments linked than were requested. */
  partialAttachmentWarning: string;
  /** COMPLETED log line + its structured fields (`id` is added here). */
  completed: { label: string; details?: Record<string, unknown> };
  /** SSE payload, minus `messageId` — only known after the insert. */
  notification: Omit<NewMessageNotification, 'messageId'>;
  /** Runs once the row is durable and the ping is out, before the 201 is
   *  written. POST / uses it to emit the announcement audit event. */
  onPersisted?: (messageId: string) => void;
  /** Human-readable text on the 201. */
  successMessage: string;
}

/**
 * The tail every send route shares: insert the row, link the caller's
 * pre-uploaded attachments, log COMPLETED, count the domain metric, push the
 * real-time NEW_MESSAGE ping, and answer 201 with the org-name-enriched row.
 *
 * Extracted because it was written out three times (send / support / reply)
 * and every copy had to remember the SAME two easily-forgotten steps — the
 * `message_events_total` counter and the SSE notify. A fourth send route that
 * skipped either would leave the metric silently under-counting and the
 * recipient's inbox not refreshing, with nothing failing to say so.
 *
 * Attachment linking is deliberately non-fatal: only the caller's own
 * still-pending uploads link (enforced in the service), so a mismatch means the
 * client sent a bogus / foreign / already-linked id. The message stands with
 * whatever validly linked, and the shortfall is logged.
 */
async function persistAndRespond(
  sseManager: SSEManager,
  ctx: RequestContext,
  res: Response,
  opts: PersistOptions,
): Promise<void> {
  const message = await messageService.create(opts.data, opts.userId);

  if (opts.attachmentIds?.length) {
    const linked = await attachmentService.linkToMessage(opts.attachmentIds, message.id, opts.orgId, opts.userId);
    if (linked.length !== opts.attachmentIds.length) {
      ctx.log('WARN', opts.partialAttachmentWarning, { requested: opts.attachmentIds.length, linked: linked.length });
    }
  }

  ctx.log('COMPLETED', opts.completed.label, { id: message.id, ...opts.completed.details });

  // Domain metric — a message row was created. Tagged by action only to keep
  // label cardinality bounded (no orgId/messageId).
  incCounter('message_events_total', { action: 'created' });

  notifyNewMessage(
    sseManager,
    { ...opts.notification, messageId: message.id },
    (err) => ctx.log('WARN', 'Failed to send SSE notification', { error: errorMessage(err) }),
  );

  opts.onPersisted?.(message.id);

  return sendSuccess(res, 201, await enrichOneWithOrgNames(message), opts.successMessage);
}

/**
 * Create the message creation router (authenticated).
 *
 * Registers:
 * - POST /messages           -- create a new announcement or conversation
 * - POST /messages/support   -- contact the support desk (recipient forced)
 * - POST /messages/:id/reply -- reply to an existing thread
 * @param sseManager - SSE manager for pushing real-time notifications
 * @returns Express Router
 */
export function createCreateMessageRoutes(sseManager: SSEManager): Router {
  const router = Router();

  // POST /messages — Create new message. `audited` declares the ONLY action this
  // route emits: a sysadmin org-wide announcement. 1:1 conversations are
  // deliberately not audited (see the emission below).
  router.post('/', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), sendLimiter, audited('message.announcement.create'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
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

    // Synchronous recipient-shape rules (announcement authority + '*' broadcast
    // reservation + per-user targeting) — see validateRecipient for each rule.
    const rejection = validateRecipient({
      messageType,
      recipientOrgId,
      recipientUserId,
      isSysadmin: isSystemAdmin(req),
    });
    if (rejection) {
      return rejection.status === 403
        ? sendError(res, 403, rejection.message, rejection.code)
        : sendBadRequest(res, rejection.message, rejection.code);
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
    };

    return persistAndRespond(sseManager, ctx, res, {
      data: messageData,
      orgId,
      userId,
      attachmentIds,
      partialAttachmentWarning: 'Some attachments did not link',
      completed: { label: 'Message created', details: { messageType } },
      notification: {
        recipientOrgId,
        subject,
        targeted: !!recipientUserId,
        senderOrgId: orgId,
        messageType,
      },
      // Audit ONLY admin broadcasts. Announcements are sysadmin org-wide
      // broadcasts (gated above to messageType==='announcement' + recipient '*');
      // 1:1 conversations/replies are intentionally NOT audited — they are noisy
      // and would pull private message content into the trail. `details` carries
      // SAFE METADATA ONLY (subject/type/recipient scope) — never the body.
      // Fire-and-forget: emission never throws and is not awaited.
      onPersisted: (messageId) => {
        if (messageType !== 'announcement') return;
        recordAudit({
          action: 'message.announcement.create',
          actorId: actorId({ userId }),
          orgId,
          targetId: messageId,
          details: {
            subject,
            messageType,
            recipientScope: 'org-wide',
          },
        });
      },
      successMessage: 'Message created successfully',
    });
  }));

  // POST /messages/support — Contact the support desk.
  //
  // Reaching support is SELF-SERVICE: every member who can open the messages
  // page must be able to file a request, including a read-only member who holds
  // no `messages:write` and therefore cannot use POST / (whose write gate stays
  // correct for ordinary org-to-org sends). So the floor here is the same
  // `messages:read` the inbox itself requires — and it rides the ROUTE, not the
  // handler, so the generated route table advertises it truthfully. Plain
  // `requirePermission`, never `requirePermissionOrService`: a service principal
  // has no support request of its own to file (support-replies-out go back
  // through POST /, where a service token may target any org).
  //
  // Shares the send limiter with POST / and POST /:id/reply — one org can't
  // flood the desk by switching routes.
  //
  // Deliberately NOT audited, exactly like the 1:1 conversation POST / creates:
  // only admin broadcasts and the destructive delete/restore/purge reach the
  // central trail (see the `audited` note on POST / and the route-coverage
  // exception that records this).
  router.post('/support', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:read'), sendLimiter, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    // The recipient is NOT a client input on this route. Whatever the body
    // carried for recipientOrgId / recipientUserId / messageType / channel is
    // OVERWRITTEN here, before validation — a forged recipient is discarded,
    // never honoured and never an error the caller can probe. Everything else
    // (subject / content / priority / attachmentIds) goes through the SAME
    // MessageCreateSchema the ordinary send validates against.
    const supportAlias = getPrimarySupportAlias();
    req.body = {
      ...(req.body as Record<string, unknown> | undefined),
      recipientOrgId: supportAlias,
      recipientUserId: undefined,
      messageType: 'conversation' as const,
      channel: SUPPORT_CHANNEL,
    };

    const validation = validateBody(req, MessageCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    // Read back ONLY the caller-owned fields; the recipient is re-derived from
    // the forced alias below rather than from the validated body, so no schema
    // change can ever let a client value decide where this lands.
    const { subject, content, priority, attachmentIds } = validation.value;

    // Same alias resolution the ordinary send uses (support@… → system org).
    // When SUPPORT_ALIASES is unconfigured the primary alias is the well-known
    // fallback, which resolves to itself — the support desk is the system org
    // either way, so fall back to it explicitly rather than addressing a
    // nonexistent org named after the alias.
    const { resolvedOrgId, wasAlias } = resolveRecipientAlias(supportAlias);
    const recipientOrgId = wasAlias ? resolvedOrgId : SYSTEM_ORG_ID;

    // Same reachability semantics as POST / — the system support inbox is
    // reachable from every org (its fast path needs no lookup). Asserted rather
    // than assumed so that if the support desk ever moves off the system org,
    // this route can't quietly become a cross-tenant send path.
    if (!(await isRecipientReachable(orgId, recipientOrgId))) {
      ctx.log('WARN', 'Support inbox is not reachable', { recipientOrgId });
      return sendError(res, 403, 'You cannot send a message to that organization', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    ctx.log('INFO', 'Contacting support', { recipientOrgId, subject });

    const messageData: MessageInsert = {
      orgId,
      recipientOrgId: recipientOrgId.toLowerCase(),
      // Support is an org→desk conversation: never per-user targeted, never an
      // announcement, and always filed under the support channel.
      recipientUserId: null,
      messageType: 'conversation',
      channel: SUPPORT_CHANNEL,
      subject,
      content,
      priority,
      createdBy: userId,
      updatedBy: userId,
    };

    const message = await messageService.create(messageData, userId);

    // Same attachment linking as POST /: only the caller's own still-pending
    // uploads link (enforced in the service); a mismatch is logged, non-fatal.
    if (attachmentIds?.length) {
      const linked = await attachmentService.linkToMessage(attachmentIds, message.id, orgId, userId);
      if (linked.length !== attachmentIds.length) {
        ctx.log('WARN', 'Some attachments did not link', { requested: attachmentIds.length, linked: linked.length });
      }
    }

    ctx.log('COMPLETED', 'Support message created', { id: message.id });

    incCounter('message_events_total', { action: 'created' });

    notifyNewMessage(sseManager, {
      recipientOrgId,
      messageId: message.id,
      subject,
      targeted: false,
      senderOrgId: orgId,
      messageType: 'conversation',
    }, (err) => ctx.log('WARN', 'Failed to send SSE notification', { error: errorMessage(err) }));

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
    const rootMessage = await messageService.findVisibleById(id, orgId);
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

    notifyNewMessage(sseManager, {
      recipientOrgId: replyRecipientOrgId,
      messageId: reply.id,
      threadId: id,
      subject: rootMessage.subject,
      targeted: !!replyRecipientUserId,
      senderOrgId: orgId,
      messageType: replyMessageType,
    }, (err) => ctx.log('WARN', 'Failed to send SSE notification', { error: errorMessage(err) }));

    return sendSuccess(res, 201, await enrichOneWithOrgNames(reply), 'Reply sent successfully');
  }));

  return router;
}
