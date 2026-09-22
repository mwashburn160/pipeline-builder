// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model } from 'mongoose';

/**
 * The HEAD of each per-tenant audit hash chain: the highest `seq` appended so
 * far and that event's `hash` (see `helpers/audit-chain.ts`).
 *
 * - It is the append path's tail pointer: the next event gets `seq + 1` and
 *   `prevHash = hash`, so ordering never depends on wall-clock `createdAt`
 *   (which skews across replicas).
 * - It has NO TTL (contrast `audit_events`): the sequence keeps counting and the
 *   chain keeps linking even after every event has aged out, instead of
 *   silently restarting at a fresh genesis.
 * - `exportedSeq` records the last head published to write-once storage by the
 *   chain-head exporter, so each export pass only ships chains that advanced.
 *
 * `_id` is the chain key (`affectedOrgId`, or the org-less genesis key).
 */
export interface AuditChainHeadDoc {
  _id: string;
  seq: number;
  hash: string;
  /** `createdAt` of the head event — lets verify tell a head that has aged out
   *  of the audit TTL window from a truncated one. */
  headCreatedAt: Date;
  exportedSeq?: number;
  updatedAt?: Date;
}

const auditChainHeadSchema = new Schema<AuditChainHeadDoc>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true },
    hash: { type: String, required: true },
    headCreatedAt: { type: Date, required: true },
    exportedSeq: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: false, updatedAt: true },
    collection: 'audit_chain_heads',
    versionKey: false,
  },
);

export default model<AuditChainHeadDoc>('AuditChainHead', auditChainHeadSchema);
