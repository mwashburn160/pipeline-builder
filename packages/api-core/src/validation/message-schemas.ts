// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { BaseFilterSchema, BooleanQuerySchema } from './common-schemas';

/**
 * Message type schema
 */
export const MessageTypeSchema = z.enum(['announcement', 'conversation']);

/**
 * Message priority schema
 */
export const MessagePrioritySchema = z.enum(['normal', 'high', 'urgent']);

/**
 * Message filter schema for query parameters
 */
export const MessageFilterSchema = BaseFilterSchema.extend({
  threadId: z.string().uuid().optional(),
  recipientOrgId: z.string().min(1).optional(),
  messageType: MessageTypeSchema.optional(),
  isRead: BooleanQuerySchema.optional(),
  priority: MessagePrioritySchema.optional(),
});

/**
 * Message creation schema
 */
export const MessageCreateSchema = z.object({
  recipientOrgId: z.string().min(1, 'Recipient organization ID is required'),
  messageType: MessageTypeSchema.optional().default('conversation'),
  subject: z.string().min(1, 'Subject is required'),
  content: z.string().min(1, 'Content is required'),
  priority: MessagePrioritySchema.optional().default('normal'),
});

/**
 * Message reply schema
 */
export const MessageReplySchema = z.object({
  content: z.string().min(1, 'Content is required'),
});

/**
 * Infer TypeScript types from schemas
 * Note: Prefixed with "Validated" to avoid conflicts with existing type definitions
 */
export type ValidatedMessageFilter = z.infer<typeof MessageFilterSchema>;
export type ValidatedMessageCreate = z.infer<typeof MessageCreateSchema>;
export type ValidatedMessageReply = z.infer<typeof MessageReplySchema>;
