// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, type Document } from 'mongoose';

/**
 * Records external webhook event IDs so retries (SNS, Stripe) become no-ops
 * instead of duplicate side-effects.
 *
 * Source providers:
 *   - 'sns'    — AWS Marketplace SNS notifications (keyed by `MessageId`)
 *   - 'stripe' — Stripe webhook events (keyed by `event.id`)
 *
 * TWO-PHASE idempotency (crash-durability). The old design marked an event
 * "processed" BEFORE running side-effects: a crash mid-processing stranded that
 * marker for 30d, so every subsequent provider retry short-circuited as a
 * duplicate and the event was silently lost. Instead we write:
 *
 *   1. a short-lived `in_progress` CLAIM before processing (also the concurrency
 *      lock — a second concurrent delivery can't claim it), then
 *   2. a durable `done` marker only AFTER the handler succeeds.
 *
 * If the process dies between (1) and (2), the in_progress lease EXPIRES (per-doc
 * TTL on `expireAt`) and the provider's next retry re-claims and re-runs. A `done`
 * marker persists for {@link DONE_TTL_SECONDS}, long enough to outlast every
 * observed retry window. Both stages are keyed by the unique (source, eventId).
 */

export type WebhookSource = 'sns' | 'stripe';
export type WebhookStatus = 'in_progress' | 'done';

export interface WebhookDedupeDocument extends Document {
  source: WebhookSource;
  eventId: string;
  status: WebhookStatus;
  /** Per-doc TTL anchor. Short for an in_progress lease, 30d for a done marker. */
  expireAt: Date;
  createdAt: Date;
}

/** Durable "done" marker lifetime — outlasts every observed provider retry window. */
const DONE_TTL_SECONDS = 30 * 24 * 60 * 60;
/**
 * In-progress lease lifetime. Long enough to outlast the slowest handler (some
 * reversal handlers re-fetch a Stripe charge) so two pods never process the same
 * event concurrently, short enough that a crashed handler's event is retried
 * promptly. Overridable for tuning; falls back to 15 minutes.
 */
const IN_PROGRESS_TTL_SECONDS = Number(process.env.BILLING_WEBHOOK_INPROGRESS_TTL_SECONDS) || 15 * 60;

const webhookDedupeSchema = new Schema<WebhookDedupeDocument>(
  {
    source: { type: String, enum: ['sns', 'stripe'], required: true },
    eventId: { type: String, required: true },
    status: { type: String, enum: ['in_progress', 'done'], required: true, default: 'in_progress' },
    // TTL anchor (see the {expireAt} index below). Set on claim (short lease) and
    // reset on the done-marker (30d) so a single index expires both phases.
    expireAt: { type: Date, required: true },
  },
  {
    collection: 'webhook_dedupe',
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Compound unique key — same eventId across different sources is fine. This is
// what makes a duplicate delivery's claim insert trip a duplicate-key error.
webhookDedupeSchema.index({ source: 1, eventId: 1 }, { unique: true });
// Per-document TTL — Mongo evicts a doc once `expireAt` passes (expireAfterSeconds
// 0 = expire AT expireAt). Drives BOTH the short in_progress lease and the 30d
// done marker off one index.
webhookDedupeSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const WebhookDedupe =
  (mongoose.models.WebhookDedupe as mongoose.Model<WebhookDedupeDocument>) ||
  mongoose.model<WebhookDedupeDocument>('WebhookDedupe', webhookDedupeSchema);

/**
 * Phase 1 — take (or re-take) the in-progress claim. Returns `true` if the caller
 * should process the event, `false` if it's a duplicate to skip.
 *
 * Atomic upsert that matches ONLY a reclaimable state: no document (insert), or an
 * `in_progress` claim whose lease has expired (a crashed prior attempt). A LIVE
 * in_progress claim (concurrent delivery) and a durable `done` marker both fail to
 * match, so the upsert falls through to an insert that trips the unique
 * (source, eventId) index → duplicate-key → `false`. On success the caller MUST
 * call {@link markWebhookEventDone} after its side-effects (or
 * {@link releaseWebhookEvent} on a handled failure).
 */
export async function claimWebhookEvent(source: WebhookSource, eventId: string): Promise<boolean> {
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + IN_PROGRESS_TTL_SECONDS * 1000);
  try {
    // Filter matches nothing (→ insert a fresh claim) or an EXPIRED in_progress
    // lease (→ re-claim it with a new lease). `status` stays 'in_progress' via the
    // query equality on both insert and update; only the lease is $set.
    await WebhookDedupe.findOneAndUpdate(
      { source, eventId, status: 'in_progress', expireAt: { $lte: now } },
      { $set: { expireAt: leaseExpiry } },
      { upsert: true },
    );
    return true;
  } catch (err) {
    // Mongoose `MongoServerError` code 11000 = duplicate key: a live in_progress
    // claim or a durable done marker already exists → this is a duplicate delivery.
    if ((err as { code?: number }).code === 11000) {
      return false;
    }
    throw err;
  }
}

/**
 * Phase 2 — promote the in-progress claim to a durable `done` marker (30d TTL).
 * Call ONLY after the event's side-effects have succeeded. Idempotent: a redelivery
 * that races here still re-stamps the same (source, eventId) row.
 *
 * `upsert` is load-bearing: if a slow handler outlives the 15-min in-progress lease
 * and Mongo's TTL reaps the claim before this runs, a plain updateOne would match
 * nothing and write NO done-marker — yet the caller returns 200, so the completed
 * event's side-effects would re-run on the next redelivery. Upserting writes the
 * done row even when the lease has vanished. (A concurrent re-claim can't collide:
 * the unique (source,eventId) index makes its insert a duplicate → treated as a
 * dup delivery.)
 */
export async function markWebhookEventDone(source: WebhookSource, eventId: string): Promise<void> {
  await WebhookDedupe.updateOne(
    { source, eventId },
    { $set: { status: 'done', expireAt: new Date(Date.now() + DONE_TTL_SECONDS * 1000) } },
    { upsert: true },
  );
}

/**
 * Release a previously-claimed event so the provider's NEXT retry reprocesses it.
 * Call this on a HANDLED processing failure after {@link claimWebhookEvent}
 * returned `true` (an unhandled crash relies on the lease expiring instead). The
 * claim doubles as a concurrency lock, but a failed attempt must not leave a
 * marker behind — otherwise every retry short-circuits as a duplicate and the
 * event is lost.
 */
export async function releaseWebhookEvent(source: WebhookSource, eventId: string): Promise<void> {
  await WebhookDedupe.deleteOne({ source, eventId });
}
