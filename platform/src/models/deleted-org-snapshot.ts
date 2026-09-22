// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, type HydratedDocument, Types } from 'mongoose';

/**
 * Durable recovery snapshot of an org taken at SOFT-DELETE time.
 *
 * When `DELETE /organization/:id` soft-deletes an org, the full GDPR-style
 * export (`exportOrg`) is captured and persisted here BEFORE anything
 * destructive happens. If the export/persist fails the soft-delete is aborted —
 * we never lose an org without a recoverable snapshot. The document survives the
 * eventual purge (it IS the recovery artifact), so operators can hand the JSON
 * back to a customer or rebuild after a mistaken deletion.
 */
export interface DeletedOrgSnapshotData {
  /** The soft-deleted org's id (string form of its `_id`). */
  organizationId: Types.ObjectId;
  /** Denormalized org name at deletion time (so the snapshot is legible without
   *  parsing the blob). */
  name: string;
  /** The full `exportOrg` blob (Postgres + Mongo rows for the org). */
  snapshot: unknown;
  /** When the org was soft-deleted. */
  deletedAt: Date;
  /** The sysadmin (user id) who ran the delete. */
  deletedBy: string;
  createdAt: Date;
}

export type DeletedOrgSnapshotDocument = HydratedDocument<DeletedOrgSnapshotData>;

const deletedOrgSnapshotSchema = new Schema<DeletedOrgSnapshotData>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
    deletedAt: { type: Date, required: true },
    deletedBy: { type: String, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'deleted_org_snapshots',
  },
);

export default model<DeletedOrgSnapshotData>('DeletedOrgSnapshot', deletedOrgSnapshotSchema);
