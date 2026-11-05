// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 2's record (docs/plans/sales-agent.md).
 *
 * "The record is the point. It is what the admin surface lists, what the audit
 * trail references, what D12 retunes from, and what answers 'why did this
 * account get this?' without re-running anything."
 *
 * Every offer gets a row — including the ones that were NOT made. A held slot
 * (D17) and a suppressed account (D6) are rows with a reason, not absences:
 * "offers suppressed and why, PER REASON" is a product metric, because a feature
 * suppressing almost everything is misconfigured rather than careful, and that
 * is only visible if each reason is counted separately.
 */

import mongoose, { Schema } from 'mongoose';

/**
 * THREE offer types, not one (D4's crossover and Example C).
 *
 *  - `upgrade` — move a tier. The only type a percentage suits (D10), and the
 *    only one carrying a renewal cliff when discounted.
 *  - `pack` — add capacity on one dimension. Structurally hard to discount
 *    meaningfully, so usually offered at list.
 *  - `compose` — a basket sized to the dimensions actually under pressure, for
 *    an account whose usage has outgrown its tier while its headcount has not.
 *    Needs no discount, which makes it the cheapest to make and the safest to
 *    get wrong.
 */
export const OFFER_TYPES = ['upgrade', 'pack', 'compose'] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

/**
 * Terminal and non-terminal states an offer can be in.
 *
 * `declined` exists separately from `expired`, and that distinction is "the
 * single most valuable thing D12 measures": redemption is the only action
 * today, so "never saw it" and "said no" are the same row — and D6's lengthened
 * window after a decline is unimplementable without telling them apart.
 */
export const OFFER_STATUSES = ['sent', 'redeemed', 'declined', 'expired', 'withdrawn'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/**
 * Why no offer was made. Each is counted separately in Phase 6.
 *
 * `held` is the interesting one: D17 makes declining to offer a legitimate
 * OUTCOME rather than an absence — "offer when this is the best offer expected
 * within the window, not merely when an offer is permitted" — so a hold carries
 * the date it expects the better offer by, and Phase 6 can ask whether holds
 * were vindicated.
 */
export const SUPPRESSION_REASONS = [
  'offers_disabled_instance',
  'offers_disabled_account',
  'quiet_period',
  'holdout',
  'held_better_offer',
  'incomplete_profile',
  'no_rule_matched',
  'negative_ev',
  'budget_exhausted',
  'preflight_refused',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface OfferDocument extends mongoose.Document {
  /** The ACCOUNT root — offers are made to accounts, not to teams. */
  orgId: string;
  offerType: OfferType;
  /** Plan tier for `upgrade`, bundle id for `pack`, the basket for `compose`. */
  targetTier?: string;
  targetBundles: Array<{ bundleId: string; quantity: number }>;
  /**
   * WHICH SIGNALS FIRED, verbatim. The answer to "why did this account get
   * this?", and the thing that makes an offer defensible after the fact rather
   * than reconstructible by re-running a rule set that has since changed.
   */
  rationale: string[];
  /** The discount this offer carries, if any. A `compose` usually carries none. */
  discountId?: string;
  amountCents: number;
  /** The campaign the grant spends from, so budget burn-down is attributable. */
  campaign?: string;
  status: OfferStatus;
  /** When it was SENT — the clock D6's 45-day rate is measured from. */
  sentAt?: Date;
  /** Must be SHORTER than the quiet period, or the rate is undefined. */
  expiresAt?: Date;
  resolvedAt?: Date;
  /**
   * Set when NO offer was made. Mutually exclusive with `status: 'sent'` — a
   * row is either an offer or a record of why there wasn't one.
   */
  suppressedReason?: SuppressionReason;
  /** For `held_better_offer`: when the better offer is expected. */
  holdUntil?: Date;
  /** True when the account is in the measurement holdout (D7). */
  holdout: boolean;
  /** `agent` or `manual` — mixing them silently corrupts the only measurement that matters. */
  source: 'agent' | 'manual';
  /** The cycle that produced this row, for idempotency (D15). */
  cycleKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const offerSchema = new Schema<OfferDocument>(
  {
    orgId: { type: String, required: true },
    offerType: { type: String, enum: OFFER_TYPES, required: true },
    targetTier: { type: String, default: undefined },
    targetBundles: {
      type: [{ bundleId: { type: String, required: true }, quantity: { type: Number, required: true, min: 1 } }],
      default: [],
    },
    rationale: { type: [String], default: [] },
    discountId: { type: String, default: undefined },
    amountCents: { type: Number, default: 0, min: 0 },
    campaign: { type: String, default: undefined },
    status: { type: String, enum: OFFER_STATUSES, required: true },
    sentAt: { type: Date, default: undefined },
    expiresAt: { type: Date, default: undefined },
    resolvedAt: { type: Date, default: undefined },
    suppressedReason: { type: String, enum: SUPPRESSION_REASONS, default: undefined },
    holdUntil: { type: Date, default: undefined },
    holdout: { type: Boolean, default: false },
    source: { type: String, enum: ['agent', 'manual'], default: 'agent' },
    cycleKey: { type: String, required: true },
  },
  { collection: 'offers', timestamps: true },
);

/**
 * ONE ROW PER (ORG, CYCLE) — the idempotency key D15 asks for.
 *
 * A cycle that runs twice, or two replicas that both won the lock, cannot
 * produce two offers for one account: the second loses on insert. That matters
 * more here than for the profile store, because this row is paired with a
 * discount grant — a duplicate is money.
 */
offerSchema.index({ orgId: 1, cycleKey: 1 }, { unique: true });

/** The quiet-period read: this account's SENT offers, newest first. */
offerSchema.index({ orgId: 1, sentAt: -1 });

/** The admin surface and Phase 6's counts. */
offerSchema.index({ status: 1, createdAt: -1 });
offerSchema.index({ suppressedReason: 1, createdAt: -1 });

export const Offer =
  (mongoose.models.Offer as mongoose.Model<OfferDocument>) ||
  mongoose.model<OfferDocument>('Offer', offerSchema);
