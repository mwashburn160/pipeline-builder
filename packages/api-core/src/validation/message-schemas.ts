// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { BaseFilterSchema, BooleanQuerySchema } from './common-schemas.js';

/**
 * Message type schema
 */
export const MessageTypeSchema = z.enum(['announcement', 'conversation']);

/**
 * Message priority schema
 */
export const MessagePrioritySchema = z.enum(['normal', 'high', 'urgent']);

/**
 * Channel/inbox-bucket schema. Open-ended string up to 50 chars so we
 * can add new channels (support, help, billing, …) without a schema
 * migration. Constrained to a-z/0-9/dash/underscore for URL safety and
 * to keep filter conditions trivially indexable.
 */
export const MessageChannelSchema = z.string().min(1).max(50).regex(/^[a-z0-9_-]+$/);

/**
 * Message filter schema for query parameters.
 *
 * Convention for `threadId`:
 * - Omitted (undefined): no filter applied — returns messages regardless of thread.
 * - `'root'` or `null`: filter for root messages only (translated to `threadId IS NULL`
 *   by the route layer / query builder). The string sentinel `'root'` is the
 *   wire form, since URL query params can't carry a true `null`.
 * - A UUID: filter for messages in that specific thread.
 *
 * `isRead` is honored by `buildMessageConditions` in pipeline-data via a
 * `jsonb_exists(read_by, $orgId)` check on `messages.read_by` for the requesting
 * org (the function form, not the `?` operator, to avoid param-binding clashes).
 */
export const MessageFilterSchema = BaseFilterSchema.extend({
  threadId: z.union([z.string().uuid(), z.literal('root'), z.null()]).optional(),
  recipientOrgId: z.string().min(1).optional(),
  messageType: MessageTypeSchema.optional(),
  isRead: BooleanQuerySchema.optional(),
  priority: MessagePrioritySchema.optional(),
  channel: MessageChannelSchema.optional(),
  // Free-text inbox search over subject/content. Bounded so a pathological term
  // can't blow up the LIKE; the query builder escapes wildcards + ignores blanks.
  search: z.string().trim().min(1).max(200).optional(),
});

/**
 * Upper bounds on free-text message fields. Without these an unbounded
 * subject/content (e.g. a 1MB announcement) is persisted AND SSE-broadcast to
 * every org. `subject` matches the `varchar(500)` DB column so we reject rather
 * than silently truncate; `content` is a `text` column with no DB bound, so we
 * cap it at a sane 32 KiB at the app layer.
 */
export const MESSAGE_SUBJECT_MAX = 500;
export const MESSAGE_CONTENT_MAX = 32768;

/** Max attachments linkable to a single message/reply. */
export const MESSAGE_MAX_ATTACHMENTS = 5;

/**
 * Max attachment size (MiB) — env-overridable. The upload route enforces this
 * (multer `fileSize`); kept here so the bound lives with the other message
 * limits rather than only inline in the route.
 */
export const MESSAGE_ATTACHMENT_MAX_MB = Math.max(1, Number.parseInt(process.env.MESSAGE_ATTACHMENT_MAX_MB ?? '10', 10) || 10);
export const MESSAGE_ATTACHMENT_MAX_BYTES = MESSAGE_ATTACHMENT_MAX_MB * 1024 * 1024;

/**
 * Allow-list of attachment MIME types — common images + documents. Deliberately
 * excludes executables/scripts/HTML/SVG (stored-XSS / drive-by). Extend here.
 */
export const MESSAGE_ATTACHMENT_ALLOWED_MIME: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv', 'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/** Attachment metadata DTO returned to clients (never exposes the storage key). */
export interface MessageAttachmentDTO {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Attachment ids to link to a message. Each is the id returned by a prior
 * POST /messages/attachments upload; the create route links only ids that belong
 * to the caller (own org + uploader) and are still unattached.
 */
const AttachmentIdsSchema = z.array(z.string().uuid()).max(MESSAGE_MAX_ATTACHMENTS).optional();

/**
 * Message creation schema
 */
export const MessageCreateSchema = z.object({
  recipientOrgId: z.string().min(1, 'Recipient organization ID is required'),
  // Optional per-user targeting WITHIN recipientOrgId. When set, only this user
  // sees the conversation (enforced in buildMessageConditions). Conversation-only
  // and requires a concrete recipient org — the route rejects it on announcements
  // and '*' broadcasts. Bounded to the recipient_user_id column width.
  recipientUserId: z.string().min(1).max(255).optional(),
  messageType: MessageTypeSchema.optional().default('conversation'),
  channel: MessageChannelSchema.optional(),
  subject: z.string().min(1, 'Subject is required').max(MESSAGE_SUBJECT_MAX, `Subject must be at most ${MESSAGE_SUBJECT_MAX} characters`),
  content: z.string().min(1, 'Content is required').max(MESSAGE_CONTENT_MAX, `Content must be at most ${MESSAGE_CONTENT_MAX} characters`),
  priority: MessagePrioritySchema.optional().default('normal'),
  attachmentIds: AttachmentIdsSchema,
});

/**
 * Message reply schema
 */
export const MessageReplySchema = z.object({
  content: z.string().min(1, 'Content is required').max(MESSAGE_CONTENT_MAX, `Content must be at most ${MESSAGE_CONTENT_MAX} characters`),
  attachmentIds: AttachmentIdsSchema,
});

/**
 * Edit an already-sent message's CONTENT (author-only, enforced server-side).
 * Only the body is editable — subject/recipient/type/attachments are immutable
 * after send (changing them would rewrite the conversation's routing/meaning).
 */
export const MessageEditSchema = z.object({
  content: z.string().min(1, 'Content is required').max(MESSAGE_CONTENT_MAX, `Content must be at most ${MESSAGE_CONTENT_MAX} characters`),
});
