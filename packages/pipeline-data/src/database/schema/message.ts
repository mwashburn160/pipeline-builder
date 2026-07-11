// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AccessModifier, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { boolean, varchar, pgTable, text, timestamp, uuid, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Message type identifiers
 */
export type MessageType = 'announcement' | 'conversation';

/**
 * Message priority levels
 */
export type MessagePriority = 'normal' | 'high' | 'urgent';

/**
 * Table for storing internal messages between organizations and the system org.
 *
 * Features * - Announcements: System org broadcasts to all orgs (recipientOrgId = '*')
 * - Conversations: Two-way threaded messaging between an org and system org
 * - Thread support via threadId (null for root messages, references root for replies)
 * - Read tracking per message
 * - Priority levels (normal, high, urgent)
 * - Soft delete support
 *
 * @table messages
 */
export const message = pgTable('messages', {
  // Primary key
  id: uuid('id').primaryKey().defaultRandom(),

  // Organization and access control
  orgId: varchar('org_id', { length: 255 })
    .default(SYSTEM_ORG_ID)
    .notNull(),

  // Audit fields
  createdBy: text('created_by')
    .default(SYSTEM_ORG_ID)
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedBy: text('updated_by')
    .default(SYSTEM_ORG_ID)
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),

  // Threading
  threadId: uuid('thread_id'),

  // Message routing
  recipientOrgId: varchar('recipient_org_id', { length: 255 })
    .notNull(),

  // Message content
  messageType: varchar('message_type', { length: 20 })
    .$type<MessageType>()
    .default('conversation' as MessageType)
    .notNull(),
  // Logical channel/inbox bucket — 'support', 'help', etc. Nullable so
  // org-to-org conversations (which aren't channel-scoped) can omit it.
  channel: varchar('channel', { length: 50 }),
  subject: varchar('subject', { length: 500 })
    .notNull(),
  content: text('content')
    .notNull(),

  // Status
  // `readBy` is the per-participant read-receipt map: orgId → ISO timestamp.
  // Recipient marking the thread does NOT flip sender's view. Empty `{}`
  // means nobody has read it yet.
  readBy: jsonb('read_by')
    .$type<Record<string, string>>()
    .default({})
    .notNull(),
  priority: varchar('priority', { length: 20 })
    .$type<MessagePriority>()
    .default('normal' as MessagePriority)
    .notNull(),

  // Access and visibility
  accessModifier: varchar('access_modifier', { length: 10 })
    .$type<AccessModifier>()
    .default('private' as AccessModifier)
    .notNull(),
  isDefault: boolean('is_default')
    .default(false)
    .notNull(),
  isActive: boolean('is_active')
    .default(true)
    .notNull(),

  // Deletion tracking (soft delete)
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
}, (table) => ({
  // Indexes for common queries
  orgIdIdx: index('message_org_id_idx').on(table.orgId),
  recipientOrgIdIdx: index('message_recipient_org_id_idx').on(table.recipientOrgId),
  threadIdIdx: index('message_thread_id_idx').on(table.threadId),
  messageTypeIdx: index('message_message_type_idx').on(table.messageType),
  channelIdx: index('message_channel_idx').on(table.channel),
  createdAtIdx: index('message_created_at_idx').on(table.createdAt),
  activeIdx: index('message_active_idx').on(table.isActive),

  // Composite index for inbox queries (recipient + active + created)
  recipientActiveCreatedIdx: index('message_recipient_active_created_idx')
    .on(table.recipientOrgId, table.isActive, table.createdAt),

  // Composite index for org inbox (orgId + active)
  orgActiveIdx: index('message_org_active_idx').on(table.orgId, table.isActive),
}));

/**
 * TypeScript types representing database rows
 */
export type Message = typeof message.$inferSelect;
export type MessageInsert = typeof message.$inferInsert;

/**
 * Helper types for working with partial updates
 */
export type MessageUpdate = Partial<Omit<MessageInsert, 'id' | 'createdAt' | 'createdBy'>>;
