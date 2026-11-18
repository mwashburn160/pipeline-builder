// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The durable CASCADE OUTBOX: one row per downstream leg of an org purge or a
 * GDPR user erasure (services/cascade-outbox.ts).
 *
 * Written IN THE SAME Mongo transaction as platform's own state change — the
 * org document's hard delete, or the user's deletion — so the two can never
 * disagree: if the org is gone, every service that holds its data has a
 * pending leg; if the transaction rolled back, none does. A leader-locked
 * dispatcher then delivers each leg to the owning service's idempotent
 * internal endpoint, with exponential backoff, until a 2xx (`done`) or the
 * attempt ceiling (`dead`, metered and alerted).
 *
 * `(kind, subjectId, service)` is UNIQUE, so enqueueing the same cascade twice
 * — a transaction retry, a re-run purge — is one leg, not two deliveries.
 *
 * `done` rows expire after a while (TTL on `completedAt`); `pending` and `dead`
 * rows never do — a dead leg is an unfinished erasure that an operator must see.
 */

import { Schema, model, type HydratedDocument } from 'mongoose';

/** What happened upstream that the leg propagates. */
export const CASCADE_KINDS = ['org.deleted', 'user.erased'] as const;
export type CascadeKind = (typeof CASCADE_KINDS)[number];

export const CASCADE_LEG_STATUSES = ['pending', 'done', 'dead'] as const;
export type CascadeLegStatus = (typeof CASCADE_LEG_STATUSES)[number];

/** How long a delivered leg is kept (for the status read) before it expires. */
export const CASCADE_DONE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export interface CascadeOutboxData {
  kind: CascadeKind;
  /** The org id (`org.deleted`) or user id (`user.erased`). */
  subjectId: string;
  /** The downstream leg — the owning service (see services/cascade-legs.ts). */
  service: string;
  status: CascadeLegStatus;
  /** Deliveries attempted so far. */
  attempts: number;
  /**
   * When the leg is next due. Also the in-flight LEASE: a dispatcher that picks a
   * leg pushes this forward before delivering, so a second dispatcher (or the
   * same one after a crash) does not deliver it again until the lease lapses.
   */
  nextAttemptAt: Date;
  /** The last failure, truncated. Null once delivered. */
  lastError?: string | null;
  /** The last HTTP status the owning service answered (absent when unreachable). */
  lastStatusCode?: number | null;
  /** When the leg reached `done` (drives the TTL) or `dead`. */
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CascadeOutboxDocument = HydratedDocument<CascadeOutboxData>;

const cascadeOutboxSchema = new Schema<CascadeOutboxData>(
  {
    kind: { type: String, enum: CASCADE_KINDS, required: true },
    subjectId: { type: String, required: true },
    service: { type: String, required: true },
    status: { type: String, enum: CASCADE_LEG_STATUSES, required: true, default: 'pending' },
    attempts: { type: Number, required: true, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    lastError: { type: String, default: null },
    lastStatusCode: { type: Number, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'cascade_outbox' },
);

// One leg per (cascade, service): a re-enqueue is an upsert onto the same row.
cascadeOutboxSchema.index({ kind: 1, subjectId: 1, service: 1 }, { unique: true });
// The dispatcher's scan: due pending legs, oldest first.
cascadeOutboxSchema.index({ status: 1, nextAttemptAt: 1 });
// Delivered legs age out; pending/dead rows carry `completedAt: null` (dead
// sets it too, so the TTL is partial on status).
cascadeOutboxSchema.index(
  { completedAt: 1 },
  { expireAfterSeconds: CASCADE_DONE_RETENTION_SECONDS, partialFilterExpression: { status: 'done' } },
);

export default model<CascadeOutboxData>('CascadeOutbox', cascadeOutboxSchema);
