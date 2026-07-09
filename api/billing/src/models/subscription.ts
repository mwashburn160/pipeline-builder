// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document } from 'mongoose';

// Types

export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete';
export type BillingInterval = 'monthly' | 'annual';

export interface SubscriptionDocument extends Document {
  orgId: string;
  planId: string;
  status: SubscriptionStatus;
  interval: BillingInterval;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  externalId?: string;
  externalCustomerId?: string;
  /** Number of consecutive failed payment attempts in the current period. */
  failedPaymentAttempts: number;
  /** When the first payment failure occurred (starts grace period). */
  firstFailedAt?: Date;
  /** Purchased add-on bundles (docs/billing-bundles.md). Each stacks its grants
   *  onto the account's effective limits; defaults to `[]`. */
  addons: Array<{ bundleId: string; quantity: number }>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// Schema

const subscriptionSchema = new Schema<SubscriptionDocument>(
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
    failedPaymentAttempts: { type: Number, default: 0 },
    firstFailedAt: { type: Date, default: null },
    addons: {
      type: [{ bundleId: { type: String, required: true }, quantity: { type: Number, required: true, min: 1 } }],
      default: [],
    },
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

// Sparse index for AWS Marketplace customer lookup (SNS webhook queries).
// Enforce uniqueness on the active row only — historical canceled rows
// keep their identifier without colliding.
subscriptionSchema.index(
  { 'metadata.awsCustomerIdentifier': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'status': 'active',
      'metadata.awsCustomerIdentifier': { $exists: true, $type: 'string' },
    },
  },
);

// Grace-period scan in subscription-lifecycle (status='past_due', firstFailedAt $lte cutoff).
subscriptionSchema.index({ status: 1, firstFailedAt: 1 });

// Stale-active + renewal-reminder scans (status='active', currentPeriodEnd $lt/$lte window).
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

// Model (safe for re-registration in tests)

export const Subscription =
  (mongoose.models.Subscription as mongoose.Model<SubscriptionDocument>) ||
  mongoose.model<SubscriptionDocument>('Subscription', subscriptionSchema);
