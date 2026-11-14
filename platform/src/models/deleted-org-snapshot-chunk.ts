// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, type HydratedDocument, Types } from 'mongoose';

/**
 * One slice of a deleted-org snapshot's serialized export (see
 * {@link import('./deleted-org-snapshot.js')} for why it is chunked). Each chunk
 * is far below the 16 MB BSON limit, and carries the header's `expiresAt` so
 * the TTL monitor removes it on the same schedule — no orphan sweep needed.
 */
export interface DeletedOrgSnapshotChunkData {
  snapshotId: Types.ObjectId;
  seq: number;
  data: Buffer;
  expiresAt: Date;
}

export type DeletedOrgSnapshotChunkDocument = HydratedDocument<DeletedOrgSnapshotChunkData>;

const deletedOrgSnapshotChunkSchema = new Schema<DeletedOrgSnapshotChunkData>(
  {
    snapshotId: { type: Schema.Types.ObjectId, required: true },
    seq: { type: Number, required: true },
    data: { type: Buffer, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'deleted_org_snapshot_chunks', versionKey: false },
);

deletedOrgSnapshotChunkSchema.index({ snapshotId: 1, seq: 1 }, { unique: true });
deletedOrgSnapshotChunkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model<DeletedOrgSnapshotChunkData>('DeletedOrgSnapshotChunk', deletedOrgSnapshotChunkSchema);
