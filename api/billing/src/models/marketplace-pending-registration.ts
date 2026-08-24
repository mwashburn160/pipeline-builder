// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document } from 'mongoose';
import type { BillingInterval } from './subscription.js';

/**
 * A resolved-but-unclaimed AWS Marketplace registration.
 *
 * The Marketplace fulfillment flow is two-phase because the AWS purchaser is not
 * yet a Pipeline Builder user when they land on the fulfillment URL:
 *
 *  1. **resolve** (`POST /billing/marketplace/resolve`, unauthenticated, the AWS
 *     redirect target) exchanges the `x-amzn-marketplace-token` for the customer
 *     identity + entitled plan and banks it here under a random `registrationRef`.
 *     No subscription is created yet — there is no org to bind it to.
 *  2. **claim** (`POST /billing/marketplace/claim`, authenticated) is called once
 *     the purchaser has signed in / signed up; it creates the real subscription
 *     for the caller's org and deletes this record (single-use).
 *
 * The record is short-lived (TTL) so an abandoned registration doesn't linger,
 * and single-use (deleted on claim) so a `registrationRef` can't bind twice.
 * Per repo policy it stores the AWS **customer identifier** (opaque) and product
 * code only — never the AWS account id.
 */
export interface MarketplacePendingRegistrationDocument extends Document<string> {
  _id: string; // the registrationRef (random, opaque, single-use)
  awsCustomerIdentifier: string;
  awsProductCode: string;
  planId: string;
  dimension?: string;
  interval: BillingInterval;
  createdAt: Date;
  expiresAt: Date;
}

const schema = new Schema<MarketplacePendingRegistrationDocument>(
  {
    _id: { type: String },
    awsCustomerIdentifier: { type: String, required: true, index: true },
    awsProductCode: { type: String, required: true },
    planId: { type: String, required: true },
    dimension: { type: String },
    interval: { type: String, enum: ['monthly', 'annual'], required: true },
    // TTL: Mongo purges the doc once `expiresAt` passes (abandoned registration).
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { collection: 'marketplace_pending_registrations', timestamps: { createdAt: true, updatedAt: false } },
);

export const MarketplacePendingRegistration =
  (mongoose.models.MarketplacePendingRegistration as mongoose.Model<MarketplacePendingRegistrationDocument>) ||
  mongoose.model<MarketplacePendingRegistrationDocument>('MarketplacePendingRegistration', schema);

/** How long a resolved-but-unclaimed registration stays valid (30 minutes). */
export const PENDING_REGISTRATION_TTL_MS = 30 * 60 * 1000;
