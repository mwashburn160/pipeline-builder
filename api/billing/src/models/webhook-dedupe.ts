// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document } from 'mongoose';

/**
 * Records every external webhook event ID we've successfully processed
 * so retries (SNS, Stripe) become no-ops instead of duplicate side-effects.
 *
 * Source providers:
 *   - 'sns'    — AWS Marketplace SNS notifications (keyed by `MessageId`)
 *   - 'stripe' — Stripe webhook events (keyed by `event.id`)
 *
 * Documents auto-expire after 30 days via the TTL index — long enough to
 * outlast every observed retry window from these providers.
 */

export type WebhookSource = 'sns' | 'stripe';

export interface WebhookDedupeDocument extends Document {
  source: WebhookSource;
  eventId: string;
  createdAt: Date;
}

const TTL_SECONDS = 30 * 24 * 60 * 60;

const webhookDedupeSchema = new Schema<WebhookDedupeDocument>(
  {
    source: { type: String, enum: ['sns', 'stripe'], required: true },
    eventId: { type: String, required: true },
  },
  {
    collection: 'webhook_dedupe',
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Compound unique key — same eventId across different sources is fine.
webhookDedupeSchema.index({ source: 1, eventId: 1 }, { unique: true });
// TTL index — Mongo evicts after TTL_SECONDS from createdAt.
webhookDedupeSchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });

export const WebhookDedupe =
  (mongoose.models.WebhookDedupe as mongoose.Model<WebhookDedupeDocument>) ||
  mongoose.model<WebhookDedupeDocument>('WebhookDedupe', webhookDedupeSchema);

/**
 * Record a webhook event ID. Returns `true` if this is the first time we've
 * seen it (caller should process), `false` if it's a duplicate (caller should
 * skip). Insert is the source of truth — concurrent callers with the same
 * (source, eventId) will produce exactly one `true` return.
 */
export async function claimWebhookEvent(source: WebhookSource, eventId: string): Promise<boolean> {
  try {
    await WebhookDedupe.create({ source, eventId });
    return true;
  } catch (err) {
    // Mongoose `MongoServerError` code 11000 = duplicate key
    if ((err as { code?: number }).code === 11000) {
      return false;
    }
    throw err;
  }
}
