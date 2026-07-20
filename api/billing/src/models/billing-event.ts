// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document } from 'mongoose';

// Types

export type BillingEventType =
  | 'subscription_created'
  | 'subscription_updated'
  | 'subscription_canceled'
  | 'subscription_reactivated'
  | 'plan_changed'
  | 'interval_changed'
  | 'payment_succeeded'
  | 'payment_failed';

export interface BillingEventDocument extends Document {
  orgId: string;
  subscriptionId?: string;
  type: BillingEventType;
  /** The user id (JWT `sub`) that initiated this change, when a request context
   *  exists. Undefined for system/non-request paths (webhook, lifecycle cron,
   *  marketplace SNS) — we never fabricate an actor for those. */
  actorId?: string;
  details: Record<string, unknown>;
  createdAt: Date;
}

// Schema

const billingEventSchema = new Schema<BillingEventDocument>(
  {
    orgId: { type: String, required: true, index: true },
    subscriptionId: { type: String, default: null },
    // Sparse, non-indexed: the acting user's id (JWT `sub`) for request-context
    // changes; absent on system paths. Not indexed — attribution is read via the
    // org-scoped events list, never queried by actor.
    actorId: { type: String, default: undefined },
    type: {
      type: String,
      enum: [
        'subscription_created',
        'subscription_updated',
        'subscription_canceled',
        'subscription_reactivated',
        'plan_changed',
        'interval_changed',
        'payment_succeeded',
        'payment_failed',
      ],
      required: true,
    },
    // Free-form change context (old/new values, reasons). MUST NEVER carry
    // payment tokens, card numbers, or other PII — this is an audit log, not a
    // payment record. Only store non-sensitive descriptors of what changed.
    details: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: 'billing_events',
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Model (safe for re-registration in tests)

export const BillingEvent =
  (mongoose.models.BillingEvent as mongoose.Model<BillingEventDocument>) ||
  mongoose.model<BillingEventDocument>('BillingEvent', billingEventSchema);
