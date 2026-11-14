// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, type HydratedDocument, Types } from 'mongoose';

/**
 * Recovery snapshot of an org taken at SOFT-DELETE time — the HEADER. The
 * export itself lives in `deleted_org_snapshot_chunks` (see
 * {@link import('./deleted-org-snapshot-chunk.js')}), written and read only
 * through `services/deleted-org-snapshot-store.ts`.
 *
 * When `DELETE /organization/:id` soft-deletes an org, the full GDPR-style
 * export (`exportOrg`) is captured and persisted BEFORE anything destructive
 * happens. If the export/persist fails the soft-delete is aborted — we never
 * lose an org without a recoverable snapshot.
 *
 * WHY CHUNKED. The export holds every Postgres table for the org plus up to
 * 50,000 audit events; stored as one Mongo document it hits the 16 MB BSON limit
 * for any active tenant, the insert throws, and the org can never be deleted.
 * The header records the serialized size and SHA-256, so a read can prove it
 * reassembled exactly what was written.
 *
 * RETENTION. A snapshot is a copy of deleted data, so it is kept exactly as
 * long as the deleted org itself: `expiresAt` is the org's purge time
 * (`deletedAt + orgPurgeRetentionMs()`, 30 days by default — the privacy
 * policy's "deleted items are removed after 30 days"), enforced by a TTL index
 * here and on every chunk.
 */
export interface DeletedOrgSnapshotData {
  /** The soft-deleted org's id. */
  organizationId: Types.ObjectId;
  /** Denormalized org name at deletion time (so the snapshot is legible without
   *  reassembling the blob). */
  name: string;
  /** When the org was soft-deleted. */
  deletedAt: Date;
  /** The user id who ran the delete. */
  deletedBy: string;
  /** Byte length of the serialized (UTF-8 JSON) export. */
  byteLength: number;
  /** SHA-256 (hex) of the serialized export. */
  sha256: string;
  /** How many chunks hold it (`seq` 0..chunkCount-1). */
  chunkCount: number;
  /** When the TTL monitor removes the snapshot (header and chunks). */
  expiresAt: Date;
  createdAt: Date;
}

export type DeletedOrgSnapshotDocument = HydratedDocument<DeletedOrgSnapshotData>;

const deletedOrgSnapshotSchema = new Schema<DeletedOrgSnapshotData>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    deletedAt: { type: Date, required: true },
    deletedBy: { type: String, required: true },
    byteLength: { type: Number, required: true },
    sha256: { type: String, required: true },
    chunkCount: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'deleted_org_snapshots',
  },
);

deletedOrgSnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model<DeletedOrgSnapshotData>('DeletedOrgSnapshot', deletedOrgSnapshotSchema);
