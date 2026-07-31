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
  /** The single active price DISCOUNT coupon (onetime XOR recurring), if any.
   *  Stripe permits one coupon per subscription, so this is a scalar — usage
   *  credits are tracked separately below and coexist with a coupon. */
  /** A standing RECURRING discount rule — grants a usage credit EACH period until
   *  removed (onetime/credit discounts don't persist here; they grant once into
   *  the balance below). Price-only; realized as a customer-balance credit. */
  recurringDiscount?: {
    discountId: string;
    unit: 'dollar' | 'percent';
    value: number;
    appliedAt: Date;
  } | null;
  /** Usage-credit balance available to offset future costs. On **Stripe** this is a
   *  local MIRROR of the Stripe customer credit balance (Stripe is authoritative,
   *  updated from invoice webhooks) — so it reflects the customer's TOTAL credit,
   *  which may include non-discount credits (refunds, goodwill) posted in Stripe,
   *  not only discount credit. On **AWS Marketplace** there is no provider balance,
   *  so this value IS authoritative and is drawn down by metered withholding.
   *  Defaults to 0. */
  creditBalanceCents: number;
  /** Provenance of every granted usage credit (which discount, how much, ref).
   *  `dedupeKey` is set on per-period recurring re-grants so a redelivered
   *  invoice webhook doesn't append a duplicate ledger row. */
  creditLedger: Array<{ discountId: string; cents: number; appliedAt: Date; fulfillmentRef?: { kind: string; ref: string }; dedupeKey?: string }>;
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
    recurringDiscount: {
      type: {
        discountId: { type: String, required: true },
        unit: { type: String, enum: ['dollar', 'percent'], required: true },
        value: { type: Number, required: true },
        appliedAt: { type: Date, required: true },
      },
      default: null,
    },
    creditBalanceCents: { type: Number, default: 0, min: 0 },
    creditLedger: {
      // No per-entry `_id`: entries are matched by (discountId, dedupeKey),
      // never by ObjectId, so the auto-id is dead weight on a growing array.
      type: [{
        _id: false,
        discountId: { type: String, required: true },
        cents: { type: Number, required: true },
        appliedAt: { type: Date, required: true },
        fulfillmentRef: { type: { kind: String, ref: String }, default: undefined, _id: false },
        // Set on per-period recurring/combo re-grants; a redelivered invoice
        // webhook is deduped on (discountId, dedupeKey). Absent for a
        // one-time grant. Must be in the schema or strict mode strips it and the
        // idempotency guard silently double-grants.
        dedupeKey: { type: String, default: undefined },
      }],
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
