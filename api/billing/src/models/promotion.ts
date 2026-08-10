// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document } from 'mongoose';

// Types

/** Lifecycle events a promotion can auto-grant on. `manual` = admin-triggered only.
 *  `referral` = two-sided (phase 2c): a new org subscribing with a referral code
 *  credits the referee now and the referrer once the referee first pays. */
export const PROMOTION_EVENTS = ['subscription_created', 'plan_change', 'manual', 'referral'] as const;
export type PromotionEvent = (typeof PROMOTION_EVENTS)[number];

/** `onetime` grants once; `recurring` re-grants each billing period (phase 2a),
 *  re-granted from the periodic reconcile/metering path with period-keyed idempotency. */
export const PROMOTION_KINDS = ['onetime', 'recurring'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

/** Credit magnitude unit. `dollar` = CENTS; `percent` = percent-of-plan-price (mirrors
 *  the discount codec) — resolved to cents at grant time via `creditCents`. */
export const PROMOTION_UNITS = ['dollar', 'percent'] as const;
export type PromotionUnit = (typeof PROMOTION_UNITS)[number];

/** Eligibility predicate — every present field must match for a promo to fire. */
export interface PromotionConditions {
  /** Restrict to these plan tiers. */
  tiers?: string[];
  /** Restrict to these billing intervals. */
  intervals?: Array<'monthly' | 'annual'>;
  /** Only the org's FIRST-ever subscription (no prior subscription doc). */
  firstSubscriptionOnly?: boolean;
}

/**
 * A rule-driven credit campaign. Unlike a `Discount` (redeemed/manually granted),
 * a promotion AUTO-grants a usage credit when an org hits its trigger, bounded by
 * a campaign budget. Realized through the same usage-credit machinery
 * (`creditBalanceCents` / `creditLedger`), so a promotion is a GRANT SOURCE, not a
 * new realization path. `spentCents`/`grantsCount` are a reconciled ADVISORY cache
 * — the ledger (Σ `promo:<_id>` entries) is the source of truth for spend.
 */
export interface PromotionDocument extends Document<string> {
  _id: string;
  name: string;
  /** Reporting/campaign label carried onto each granted ledger line. */
  campaign?: string;
  value: number;
  unit: PromotionUnit;
  kind: PromotionKind;
  /** For a `referral` promotion: the REFERRER's grant magnitude (same unit as
   *  `value`, which is the referee's). Absent ⇒ referrer gets the same as referee. */
  referrerValue?: number;
  trigger: { event: PromotionEvent; conditions?: PromotionConditions };
  /** Active window; absent bound = open-ended on that side. */
  startsAt?: Date;
  endsAt?: Date;
  /** Total issuable budget in cents (committed, i.e. reserved on grant). */
  budgetCents: number;
  /** Reconciled advisory cache of reserved spend (authority = the ledger). */
  spentCents: number;
  /** Reconciled advisory count of grants. */
  grantsCount: number;
  /** Per-org grant ceiling in cents (clamps a single grant). */
  perOrgCapCents?: number;
  /** Global grant-count cap; absent = unlimited. */
  maxGrants?: number;
  isActive: boolean;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Schema

const promotionSchema = new Schema<PromotionDocument>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    campaign: { type: String, default: undefined },
    value: { type: Number, required: true, min: 1 },
    unit: { type: String, enum: [...PROMOTION_UNITS], required: true },
    kind: { type: String, enum: [...PROMOTION_KINDS], default: 'onetime' },
    referrerValue: { type: Number, default: undefined, min: 1 },
    trigger: {
      type: {
        event: { type: String, enum: [...PROMOTION_EVENTS], required: true },
        conditions: {
          type: {
            tiers: { type: [String], default: undefined },
            intervals: { type: [String], default: undefined },
            firstSubscriptionOnly: { type: Boolean, default: undefined },
          },
          default: undefined,
          _id: false,
        },
      },
      required: true,
      _id: false,
    },
    startsAt: { type: Date, default: undefined },
    endsAt: { type: Date, default: undefined },
    budgetCents: { type: Number, required: true, min: 1 },
    spentCents: { type: Number, default: 0, min: 0 },
    grantsCount: { type: Number, default: 0, min: 0 },
    perOrgCapCents: { type: Number, default: undefined, min: 1 },
    maxGrants: { type: Number, default: undefined, min: 1 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: undefined },
  },
  {
    collection: 'promotions',
    timestamps: true,
    // `_id` is a caller-supplied opaque string (`promo_<uuid>`), not an ObjectId.
    _id: false,
  },
);

// The engine scans active, in-window promotions by trigger event on every
// lifecycle hit — this index keeps that hot path off a collection scan.
promotionSchema.index({ 'isActive': 1, 'trigger.event': 1, 'startsAt': 1, 'endsAt': 1 });
// Admin console list, filterable by campaign.
promotionSchema.index({ campaign: 1 });

// Model (safe for re-registration in tests)

export const Promotion =
  (mongoose.models.Promotion as mongoose.Model<PromotionDocument>) ||
  mongoose.model<PromotionDocument>('Promotion', promotionSchema);
