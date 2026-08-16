// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { varchar, pgTable, text, timestamp, uuid, integer, index } from 'drizzle-orm/pg-core';

/**
 * File/image attachments for messages.
 *
 * The blob itself lives in S3-compatible object storage (MinIO); this table
 * holds only the METADATA + the storage key. A row is created on upload with
 * `message_id = NULL` (pending) and linked to a message when that message is
 * sent — so an upload that's never attached is a harmless orphan the retention
 * sweep can reap. Tenant-scoped by `org_id` (RLS); visibility of the blob is
 * gated at the API layer by whether the caller can read the parent message.
 *
 * @table message_attachments
 */
export const messageAttachment = pgTable('message_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Tenancy — the uploader's org. RLS-scoped like every other tenant table.
  orgId: varchar('org_id', { length: 255 }).notNull(),

  // The message this attachment belongs to. NULL while an upload is pending
  // (uploaded but not yet attached to a sent message).
  messageId: uuid('message_id'),

  // Who uploaded it (user id) — for audit + the pending-upload owner check.
  uploadedBy: text('uploaded_by').notNull(),

  // Original client filename (display + Content-Disposition on download).
  filename: varchar('filename', { length: 255 }).notNull(),

  // Validated MIME type (allow-list enforced at upload).
  contentType: varchar('content_type', { length: 128 }).notNull(),

  // Size in bytes (bounded at upload).
  sizeBytes: integer('size_bytes').notNull(),

  // Object key in the attachments bucket (e.g. `<orgId>/<uuid>/<filename>`).
  storageKey: varchar('storage_key', { length: 512 }).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // Fetch a message's attachments.
  messageIdIdx: index('message_attachment_message_id_idx').on(table.messageId),
  // Tenant scoping + pending-upload lookups by owner.
  orgIdIdx: index('message_attachment_org_id_idx').on(table.orgId),
}));

/** TypeScript row types. */
export type MessageAttachment = typeof messageAttachment.$inferSelect;
export type MessageAttachmentInsert = typeof messageAttachment.$inferInsert;
