// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode } from '@pipeline-builder/api-core';
import type { SSEManager } from '@pipeline-builder/api-server';

/** The broadcast recipient — reserved for sysadmin announcements. */
const BROADCAST = '*';

export interface RecipientInput {
  messageType: 'announcement' | 'conversation';
  /** Recipient org AFTER alias resolution (e.g. support@… → system org id). */
  recipientOrgId: string;
  recipientUserId?: string | null;
  /** Whether the caller is a Pipeline Builder sysadmin. */
  isSysadmin: boolean;
}

export interface RecipientRejection {
  status: 400 | 403;
  message: string;
  code: ErrorCode;
}

/**
 * Pure, synchronous recipient-shape rules for a new message. Returns the FIRST
 * violated rule (checked in this order), or null when the recipient is
 * acceptable. The async cross-tenant reachability + DM-membership gates run
 * after this in the route, since they need platform lookups.
 *
 *  1. Announcements are sysadmin broadcasts — only sysadmins may send them,
 *     regardless of which org they are currently scoped to.
 *  2. An announcement must target '*' (broadcast).
 *  3. A conversation needs a concrete recipient.
 *  4. A conversation must never target '*' — for ANY caller, including
 *     sysadmins/service principals who skip the reachability gate. Otherwise a
 *     '*'-recipient conversation lands in every org's inbox: an un-audited
 *     broadcast masquerading as a 1:1 message.
 *  5. Per-user targeting is conversation-only and needs a concrete org; on a
 *     broadcast it is rejected rather than silently dropped, so a mis-built
 *     client can't believe it sent a private message when it broadcast org-wide.
 */
export function validateRecipient(input: RecipientInput): RecipientRejection | null {
  const { messageType, recipientOrgId, recipientUserId, isSysadmin } = input;

  if (messageType === 'announcement' && !isSysadmin) {
    return { status: 403, message: 'Only sysadmins can create announcements', code: ErrorCode.INSUFFICIENT_PERMISSIONS };
  }
  if (messageType === 'announcement' && recipientOrgId !== BROADCAST) {
    return { status: 400, message: 'Announcements must use "*" as recipientOrgId for broadcast', code: ErrorCode.VALIDATION_ERROR };
  }
  if (messageType === 'conversation' && !recipientOrgId) {
    return { status: 400, message: 'recipientOrgId is required for conversations', code: ErrorCode.VALIDATION_ERROR };
  }
  if (messageType === 'conversation' && recipientOrgId === BROADCAST) {
    return {
      status: 400,
      message: 'Conversations cannot use "*" as recipientOrgId; "*" is reserved for announcement broadcasts',
      code: ErrorCode.VALIDATION_ERROR,
    };
  }
  if (recipientUserId && (messageType === 'announcement' || recipientOrgId === BROADCAST)) {
    return { status: 400, message: 'recipientUserId is only valid on a conversation to a specific organization', code: ErrorCode.VALIDATION_ERROR };
  }
  return null;
}

export interface NewMessageNotification {
  /** Recipient org of the message; '*' broadcasts to every connected org. */
  recipientOrgId: string;
  messageId: string;
  /** Root message id when this is a reply. */
  threadId?: string;
  subject: string;
  /** True when the message targets one user in the recipient org. */
  targeted: boolean;
  senderOrgId: string;
  messageType: 'announcement' | 'conversation';
}

/**
 * Push the real-time NEW_MESSAGE ping for a created message or reply.
 *
 * The SSE fan-out is ORG-scoped (no per-user channel): every member of the
 * recipient org receives the event. For a per-user targeted message the subject
 * is therefore redacted, and `recipientUserId` is never included (it would tell
 * every member WHICH user was targeted). The client just refetches; server-side
 * visibility gates who actually sees the message.
 *
 * Best-effort: a delivery failure is reported to `onError` and never thrown —
 * the message is already persisted.
 */
export function notifyNewMessage(
  sseManager: Pick<SSEManager, 'send' | 'broadcast'>,
  n: NewMessageNotification,
  onError: (err: unknown) => void,
): void {
  const recipient = n.recipientOrgId.toLowerCase();
  const data = {
    action: 'NEW_MESSAGE' as const,
    messageId: n.messageId,
    ...(n.threadId ? { threadId: n.threadId } : {}),
    subject: n.targeted ? undefined : n.subject,
    senderOrgId: n.senderOrgId,
    messageType: n.messageType,
  };
  try {
    if (recipient === BROADCAST) {
      sseManager.broadcast('MESSAGE', 'New announcement', data);
    } else {
      sseManager.send(recipient, 'MESSAGE', n.threadId ? 'New reply' : 'New message', data);
    }
  } catch (err) {
    onError(err);
  }
}
