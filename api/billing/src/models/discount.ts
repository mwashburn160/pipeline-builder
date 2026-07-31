// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document } from 'mongoose';
import { DISCOUNT_UNITS, DISCOUNT_KINDS } from '../helpers/discount-code.js';
import type { DiscountUnit, DiscountKind } from '../helpers/discount-code.js';

// Types

/**
 * A mintable discount. `_id` is a random opaque handle (NOT the human-readable
 * authoring form) — the form is parsed into value/unit/kind at mint and the id
 * is what a token seals. Money fields mirror the codec representation: `value`
 * is CENTS when `unit === 'dollar'` and percent-points when `unit === 'percent'`.
 *
 * The record is the authority for redeemability: a well-formed token/alias is
 * only redeemable while its record is `isActive`, unexpired, and under
 * `maxRedemptions`. Revoking = flipping `isActive` false, which invalidates
 * EVERY token minted for this id at once.
 */
export interface DiscountDocument extends Document<string> {
  _id: string;
  value: number;
  unit: DiscountUnit;
  kind: DiscountKind;
  /** Optional reporting label (e.g. "summer24"). */
  campaign?: string;
  /** Optional short human-friendly redemption string for PUBLIC promos. */
  alias?: string;
  /** When set, the discount is bound to this ROOT billing org and no other. */
  targetOrgId?: string;
  /** Global redemption cap; `null`/absent = unlimited. */
  maxRedemptions?: number;
  timesRedeemed: number;
  /** Redemption is rejected after this instant. */
  redeemBy?: Date;
  /** When set, redeemable only on these tiers. */
  appliesToTiers?: string[];
  /** Provider fulfillment reference (Stripe coupon id, offer id, …) — provider-agnostic. */
  externalRef?: { kind: string; ref: string };
  /** JWT `sub` of the system admin who minted it (absent on seeded/system paths). */
  createdBy?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Schema

const discountSchema = new Schema<DiscountDocument>(
  {
    _id: { type: String, required: true },
    value: { type: Number, required: true, min: 1 },
    unit: { type: String, enum: [...DISCOUNT_UNITS], required: true },
    kind: { type: String, enum: [...DISCOUNT_KINDS], required: true },
    campaign: { type: String, default: undefined },
    alias: { type: String, default: undefined },
    targetOrgId: { type: String, default: undefined },
    maxRedemptions: { type: Number, default: undefined, min: 1 },
    timesRedeemed: { type: Number, default: 0, min: 0 },
    redeemBy: { type: Date, default: undefined },
    appliesToTiers: { type: [String], default: undefined },
    externalRef: { type: { kind: String, ref: String }, default: undefined, _id: false },
    createdBy: { type: String, default: undefined },
    isActive: { type: Boolean, default: true },
  },
  {
    collection: 'discounts',
    timestamps: true,
    // `_id` is a caller-supplied opaque string, not a Mongo ObjectId.
    _id: false,
  },
);

// A public promo's alias is its redemption handle — unique when present. Sparse
// so the many targeted discounts (no alias) don't collide on `null`.
discountSchema.index({ alias: 1 }, { unique: true, sparse: true });
// Admin list filters + the targeted-redemption lookup.
discountSchema.index({ targetOrgId: 1 });
discountSchema.index({ campaign: 1 });
// Active-and-unexpired scans for the admin console + expiry sweeps.
discountSchema.index({ isActive: 1, redeemBy: 1 });

// Model (safe for re-registration in tests)

export const Discount =
  (mongoose.models.Discount as mongoose.Model<DiscountDocument>) ||
  mongoose.model<DiscountDocument>('Discount', discountSchema);
