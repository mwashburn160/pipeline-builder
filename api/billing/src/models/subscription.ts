/**
 * @module models/subscription
 * @description Mongoose schema and model for organization subscriptions.
 */

import mongoose, { Schema, Document } from 'mongoose';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete';
export type BillingInterval = 'monthly' | 'annual';

export interface ISubscription extends Document {
  orgId: string;
  planId: string;
  status: SubscriptionStatus;
  interval: BillingInterval;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  externalId?: string;
  externalCustomerId?: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const subscriptionSchema = new Schema<ISubscription>(
  {
    orgId: { type: String, required: true, index: true },
    planId: { type: String, required: true },
    status: {
      type: String,
      enum: ['active', 'canceled', 'past_due', 'trialing', 'incomplete'],
      default: 'active',
    },
    interval: {
      type: String,
      enum: ['monthly', 'annual'],
      default: 'monthly',
    },
    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd: { type: Date, required: true },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    externalId: { type: String, default: null },
    externalCustomerId: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: 'subscriptions',
    timestamps: true,
  },
);

// Only one active subscription per org
subscriptionSchema.index(
  { orgId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);

// Sparse index for AWS Marketplace customer lookup (SNS webhook queries)
subscriptionSchema.index(
  { 'metadata.awsCustomerIdentifier': 1 },
  { sparse: true },
);

// ---------------------------------------------------------------------------
// Model (safe for re-registration in tests)
// ---------------------------------------------------------------------------

export const Subscription =
  (mongoose.models.Subscription as mongoose.Model<ISubscription>) ||
  mongoose.model<ISubscription>('Subscription', subscriptionSchema);
