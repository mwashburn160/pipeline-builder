// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document } from 'mongoose';

// Types

/** `pending` = referee credited at signup, referrer not yet; `qualified` = the
 *  referee reached the qualifying event (first paid invoice) and the referrer was
 *  credited. Terminal either way — a referee is referred at most once. */
export const REFERRAL_STATUSES = ['pending', 'qualified'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/**
 * A two-sided referral (phase 2c). Created when a NEW org subscribes with another
 * org's referral code (= the referrer's org id): the referee is credited
 * immediately, and the referrer is credited only once the referee QUALIFIES (first
 * paid invoice) — which defeats fake-referral farming. Both grants flow through the
 * shared promotion budget/idempotency machinery; this record tracks the pairing and
 * its lifecycle. `_id` is opaque (`ref_<uuid>`).
 */
export interface ReferralDocument extends Document<string> {
  _id: string;
  promotionId: string;
  referrerOrgId: string;
  refereeOrgId: string;
  /** Credit granted to the referee at signup (cents). */
  refereeGrantCents: number;
  /** Credit granted to the referrer on qualification (cents; 0 until qualified). */
  referrerGrantCents: number;
  status: ReferralStatus;
  qualifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Schema

const referralSchema = new Schema<ReferralDocument>(
  {
    _id: { type: String, required: true },
    promotionId: { type: String, required: true },
    referrerOrgId: { type: String, required: true },
    // A referee can be referred at most ONCE (anti-farming) — unique.
    refereeOrgId: { type: String, required: true, unique: true },
    refereeGrantCents: { type: Number, default: 0, min: 0 },
    referrerGrantCents: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: [...REFERRAL_STATUSES], default: 'pending' },
    qualifiedAt: { type: Date, default: undefined },
  },
  {
    collection: 'referrals',
    timestamps: true,
    _id: false,
  },
);

// The qualify-on-payment path looks up the pending referral by referee.
referralSchema.index({ refereeOrgId: 1, status: 1 });
// Admin/reporting: referrals a given org drove.
referralSchema.index({ referrerOrgId: 1 });

// Model (safe for re-registration in tests)

export const Referral =
  (mongoose.models.Referral as mongoose.Model<ReferralDocument>) ||
  mongoose.model<ReferralDocument>('Referral', referralSchema);
