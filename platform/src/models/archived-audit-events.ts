// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, type HydratedDocument } from 'mongoose';

/**
 * Post-purge archive of an org's audit events.
 *
 * The org-purge cascade destroys an org's live `audit_events` rows. Before it
 * does, it copies them here so the record survives the purge — for the REST OF
 * ITS RETENTION, not forever: each archived event carries `expiresAt` = its
 * original `createdAt` + `AUDIT_RETENTION_DAYS`, the moment the live row's own
 * TTL would have removed it, and a TTL index here enforces it. That is what the
 * privacy policy promises ("audit logs are kept for 90 days"); an archive kept
 * indefinitely held member emails and IPs long after the org was gone.
 *
 * Documents are stored verbatim: the original event's `_id` is preserved (so
 * re-archiving the same event on a purge retry is an idempotent upsert, not a
 * duplicate) and every original field is kept via `strict: false`. `archivedAt`
 * records when the copy was taken.
 */
export interface ArchivedAuditEventData {
  /** When this event was copied into the archive (purge time). */
  archivedAt: Date;
  /** When the TTL monitor removes it (original createdAt + audit retention). */
  expiresAt: Date;
  /** All original audit-event fields are preserved verbatim (strict: false). */
  [key: string]: unknown;
}

export type ArchivedAuditEventDocument = HydratedDocument<ArchivedAuditEventData>;

const archivedAuditEventSchema = new Schema<ArchivedAuditEventData>(
  {
    archivedAt: { type: Date, required: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  {
    // Store the full original audit document verbatim — this is a forensic
    // archive, not a shaped/queried model.
    strict: false,
    timestamps: false,
    collection: 'archived_audit_events',
  },
);

// Retrievability indexes so an operator can pull "what happened to org X" out of
// the archive after a purge. Sparse-friendly (strict:false docs always set these
// when the source event had them).
archivedAuditEventSchema.index({ orgId: 1, archivedAt: -1 });
archivedAuditEventSchema.index({ affectedOrgId: 1, archivedAt: -1 });
archivedAuditEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model<ArchivedAuditEventData>('ArchivedAuditEvent', archivedAuditEventSchema);
