// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model } from 'mongoose';

/**
 * Retention WATERMARKS of the per-tenant audit hash chains (see
 * `helpers/audit-chain.ts`): one row per retention prune of a chain, naming the
 * last event that prune deleted — its `seq` and `hash` — signed with the chain
 * HMAC key.
 *
 * Without it, deleting the OLDEST events of a chain looks exactly like
 * retention having aged them out: the first survivor's `prevHash` names a row
 * that is gone either way. With it, verify requires the first surviving event
 * to link to the latest watermark below it (or to start at seq 1 when the chain
 * was never pruned), so a head deleted outside the prune is `head-truncated`.
 *
 * APPEND-ONLY: the prune inserts, nothing updates or deletes, and there is no
 * TTL — a watermark has to outlive the rows it vouches for. Unique on
 * `(chainKey, seq)`, so a prune retried after a partial delete re-inserts the
 * same watermark as a no-op duplicate.
 */
export interface AuditChainCheckpointDoc {
  /** The chain key (`affectedOrgId`, or the org-less genesis key). */
  chainKey: string;
  /** `seq` of the last pruned event. */
  seq: number;
  /** `hash` of the last pruned event — what the first survivor's `prevHash` must be. */
  hash: string;
  /** `createdAt` of the last pruned event. */
  eventCreatedAt: Date;
  /** When the prune recorded this watermark. */
  prunedAt: Date;
  /** HMAC (domain `checkpoint`) over `{ v, chainKey, seq, hash, eventCreatedAt }`. */
  sig: string;
}

const auditChainCheckpointSchema = new Schema<AuditChainCheckpointDoc>(
  {
    chainKey: { type: String, required: true },
    seq: { type: Number, required: true },
    hash: { type: String, required: true },
    eventCreatedAt: { type: Date, required: true },
    prunedAt: { type: Date, required: true },
    sig: { type: String, required: true },
  },
  {
    timestamps: false,
    collection: 'audit_chain_checkpoints',
    versionKey: false,
  },
);

auditChainCheckpointSchema.index({ chainKey: 1, seq: 1 }, { unique: true });

export default model<AuditChainCheckpointDoc>('AuditChainCheckpoint', auditChainCheckpointSchema);
