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
 * JSONB `?` membership check on `messages.read_by` for the requesting org.
 */
export const MessageFilterSchema = BaseFilterSchema.extend({
  threadId: z.union([z.string().uuid(), z.literal('root'), z.null()]).optional(),
  recipientOrgId: z.string().min(1).optional(),
  messageType: MessageTypeSchema.optional(),
  isRead: BooleanQuerySchema.optional(),
  priority: MessagePrioritySchema.optional(),
  channel: MessageChannelSchema.optional(),
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

/**
 * Message creation schema
 */
export const MessageCreateSchema = z.object({
  recipientOrgId: z.string().min(1, 'Recipient organization ID is required'),
  messageType: MessageTypeSchema.optional().default('conversation'),
  channel: MessageChannelSchema.optional(),
  subject: z.string().min(1, 'Subject is required').max(MESSAGE_SUBJECT_MAX, `Subject must be at most ${MESSAGE_SUBJECT_MAX} characters`),
  content: z.string().min(1, 'Content is required').max(MESSAGE_CONTENT_MAX, `Content must be at most ${MESSAGE_CONTENT_MAX} characters`),
  priority: MessagePrioritySchema.optional().default('normal'),
});

/**
 * Message reply schema
 */
export const MessageReplySchema = z.object({
  content: z.string().min(1, 'Content is required').max(MESSAGE_CONTENT_MAX, `Content must be at most ${MESSAGE_CONTENT_MAX} characters`),
});
