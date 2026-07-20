// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Document } from 'mongoose';

/**
 * Durable, PERMANENT archive of audit events.
 *
 * The org-purge cascade destroys an org's live `audit_events` rows. Before it
 * does, it copies them here so the forensic record survives the purge. Unlike
 * `audit_events` — which carries a TTL index that auto-expires events after the
 * retention window — this collection has NO TTL: an archived event is kept
 * indefinitely (it IS the post-purge evidence).
 *
 * Documents are stored verbatim: the original event's `_id` is preserved (so
 * re-archiving the same event on a purge retry is an idempotent upsert, not a
 * duplicate) and every original field is kept via `strict: false`. `archivedAt`
 * records when the copy was taken.
 */
export interface ArchivedAuditEventDocument extends Document {
  /** When this event was copied into the archive (purge time). */
  archivedAt: Date;
  /** All original audit-event fields are preserved verbatim (strict: false). */
  [key: string]: unknown;
}

const archivedAuditEventSchema = new Schema<ArchivedAuditEventDocument>(
  {
    archivedAt: { type: Date, required: true, index: true },
  },
  {
    // Store the full original audit document verbatim — this is a forensic
    // archive, not a shaped/queried model.
    strict: false,
    // NO `timestamps` and — critically — NO TTL index (contrast `audit_events`,
    // which auto-expires). The archive must OUTLIVE the org purge permanently.
    timestamps: false,
    collection: 'archived_audit_events',
  },
);

// Retrievability indexes so an operator can pull "what happened to org X" out of
// the archive after a purge. Sparse-friendly (strict:false docs always set these
// when the source event had them).
archivedAuditEventSchema.index({ orgId: 1, archivedAt: -1 });
archivedAuditEventSchema.index({ affectedOrgId: 1, archivedAt: -1 });

export default model<ArchivedAuditEventDocument>('ArchivedAuditEvent', archivedAuditEventSchema);
