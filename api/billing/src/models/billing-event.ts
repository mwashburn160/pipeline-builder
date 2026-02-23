/**
 * @module models/billing-event
 * @description Mongoose schema and model for billing event audit log.
 */

import mongoose, { Schema, Document } from 'mongoose';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BillingEventType =
  | 'subscription_created'
  | 'subscription_updated'
  | 'subscription_canceled'
  | 'subscription_reactivated'
  | 'plan_changed'
  | 'interval_changed'
  | 'payment_succeeded'
  | 'payment_failed';

export interface IBillingEvent extends Document {
  orgId: string;
  subscriptionId?: string;
  type: BillingEventType;
  details: Record<string, unknown>;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const billingEventSchema = new Schema<IBillingEvent>(
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

// ---------------------------------------------------------------------------
// Model (safe for re-registration in tests)
// ---------------------------------------------------------------------------

export const BillingEvent =
  (mongoose.models.BillingEvent as mongoose.Model<IBillingEvent>) ||
  mongoose.model<IBillingEvent>('BillingEvent', billingEventSchema);
