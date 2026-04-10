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
  details: Record<string, unknown>;
  createdAt: Date;
}

// Schema

const billingEventSchema = new Schema<BillingEventDocument>(
  {
    orgId: { type: String, required: true, index: true },
    subscriptionId: { type: String, default: null },
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
