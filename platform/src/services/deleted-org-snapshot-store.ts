// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Write and read deleted-org recovery snapshots as a header plus fixed-size
 * chunks (models/deleted-org-snapshot.ts explains why a single document can't
 * hold one). The header is written LAST, so a snapshot that has a header is
 * complete; a failure part-way removes the chunks already written and rethrows,
 * and the soft-delete aborts.
 */

import crypto from 'crypto';
import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import DeletedOrgSnapshotChunk from '../models/deleted-org-snapshot-chunk.js';
import DeletedOrgSnapshot from '../models/deleted-org-snapshot.js';

const logger = createLogger('deleted-org-snapshot-store');

/** 8 MiB per chunk — half the BSON limit, leaving room for the envelope. */
export const SNAPSHOT_CHUNK_BYTES = 8 * 1024 * 1024;

/** A reassembled snapshot failed its size or digest check. */
export const SNAPSHOT_CORRUPT = 'SNAPSHOT_CORRUPT';

export interface StoreSnapshotInput {
  organizationId: string;
  name: string;
  snapshot: unknown;
  deletedAt: Date;
  deletedBy: string;
  /** When the TTL monitor removes it — the org's purge time. */
  expiresAt: Date;
}

/** Persist a snapshot; returns its id. Throws (after cleaning up) on any failure. */
export async function storeDeletedOrgSnapshot(input: StoreSnapshotInput, chunkBytes = SNAPSHOT_CHUNK_BYTES): Promise<string> {
  const payload = Buffer.from(JSON.stringify(input.snapshot), 'utf8');
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const snapshotId = new Types.ObjectId();
  const chunkCount = Math.max(1, Math.ceil(payload.length / chunkBytes));
  try {
    // One chunk per insert: a batch of them would be one wire message bounded by
    // the 48 MB message limit — the very kind of ceiling this module exists to avoid.
    for (let seq = 0; seq < chunkCount; seq += 1) {
      await DeletedOrgSnapshotChunk.create({
        snapshotId,
        seq,
        data: payload.subarray(seq * chunkBytes, (seq + 1) * chunkBytes),
        expiresAt: input.expiresAt,
      });
    }
    await DeletedOrgSnapshot.create({
      _id: snapshotId,
      organizationId: new Types.ObjectId(input.organizationId),
      name: input.name,
      deletedAt: input.deletedAt,
      deletedBy: input.deletedBy,
      byteLength: payload.length,
      sha256,
      chunkCount,
      expiresAt: input.expiresAt,
    });
  } catch (err) {
    await DeletedOrgSnapshotChunk.deleteMany({ snapshotId }).catch((cleanupErr) => logger.warn(
      'Could not remove the chunks of a failed snapshot (the TTL index will)',
      { snapshotId: String(snapshotId), error: errorMessage(cleanupErr) },
    ));
    throw err;
  }
  return String(snapshotId);
}

/**
 * Reassemble a snapshot's export, verifying its size and digest. Null when no
 * such snapshot exists (never written, or past its retention). Throws
 * SNAPSHOT_CORRUPT when a chunk is missing or the bytes don't match.
 */
export async function readDeletedOrgSnapshot(snapshotId: string): Promise<{ header: Record<string, unknown>; snapshot: unknown } | null> {
  if (!Types.ObjectId.isValid(snapshotId)) return null;
  const header = await DeletedOrgSnapshot.findById(snapshotId).lean();
  if (!header) return null;
  const chunks = await DeletedOrgSnapshotChunk.find({ snapshotId: header._id }).sort({ seq: 1 }).lean();
  if (chunks.length !== header.chunkCount || chunks.some((c, i) => c.seq !== i)) throw new Error(SNAPSHOT_CORRUPT);
  // `.lean()` hands back BSON `Binary` values, whose bytes are `.buffer`.
  const bytesOf = (d: unknown): Buffer => (Buffer.isBuffer(d) ? d : Buffer.from((d as { buffer: Uint8Array }).buffer));
  const payload = Buffer.concat(chunks.map((c) => bytesOf(c.data)));
  if (payload.length !== header.byteLength
    || crypto.createHash('sha256').update(payload).digest('hex') !== header.sha256) {
    throw new Error(SNAPSHOT_CORRUPT);
  }
  return { header: header as unknown as Record<string, unknown>, snapshot: JSON.parse(payload.toString('utf8')) };
}

/** Remove a snapshot (header + chunks) — for a soft-delete that never committed,
 *  so no recovery copy is kept of an org that was not deleted. */
export async function discardDeletedOrgSnapshot(snapshotId: string): Promise<void> {
  if (!Types.ObjectId.isValid(snapshotId)) return;
  const id = new Types.ObjectId(snapshotId);
  await DeletedOrgSnapshot.deleteOne({ _id: id });
  await DeletedOrgSnapshotChunk.deleteMany({ snapshotId: id });
}

/** The newest snapshot id for an org, or null. */
export async function latestSnapshotIdForOrg(organizationId: string): Promise<string | null> {
  if (!Types.ObjectId.isValid(organizationId)) return null;
  const doc = await DeletedOrgSnapshot.findOne({ organizationId: new Types.ObjectId(organizationId) })
    .sort({ deletedAt: -1 }).select('_id').lean();
  return doc ? String(doc._id) : null;
}
