// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BillingInterval } from '@pipeline-builder/api-core';
import mongoose, { Schema, Document } from 'mongoose';

// Types

/** Lifecycle events a promotion can auto-grant on. `manual` = admin-triggered only.
 *  `referral` = two-sided (phase 2c): a new org subscribing with a referral code
 *  credits the referee now and the referrer once the referee first pays. */
const PROMOTION_EVENTS = ['subscription_created', 'plan_change', 'manual', 'referral'] as const;
export type PromotionEvent = (typeof PROMOTION_EVENTS)[number];

/** `onetime` grants once; `recurring` re-grants each billing period (phase 2a),
 *  re-granted from the periodic reconcile/metering path with period-keyed idempotency. */
const PROMOTION_KINDS = ['onetime', 'recurring'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

/** Credit magnitude unit. `dollar` = CENTS; `percent` = percent-of-plan-price (mirrors
 *  the discount codec) — resolved to cents at grant time via `creditCents`. */
const PROMOTION_UNITS = ['dollar', 'percent'] as const;
export type PromotionUnit = (typeof PROMOTION_UNITS)[number];

/** Eligibility predicate — every present field must match for a promo to fire. */
/**
 * USAGE predicates (docs/plans/sales-agent.md Phase 1).
 *
 * Added so `matchesConditions` stays the single place eligibility is decided:
 * before this, a promotion could say "20% off annual for Pro accounts on their
 * first subscription" but not "this account has spent three consecutive periods
 * above 90% of its plugin-build cap" — which is the only kind of statement an
 * expansion offer should rest on.
 *
 * Evaluated against the `UsageProfile` history the Phase 0 store keeps, which is
 * why the store had to be append-only: `sustainedPeriods` is unanswerable from a
 * row that was overwritten.
 *
 * Deliberately a SHORT list. The plan names these four and "no more than these
 * to start", because each predicate is a thing an operator can get wrong in a
 * campaign definition, and a vocabulary nobody can hold in their head is how a
 * discount lands on the wrong account.
 */
export interface PromotionUsageConditions {
  /**
   * A named quota type must have been at or above `ratio` for
   * `sustainedPeriods` CONSECUTIVE periods.
   *
   * Sustained rather than instantaneous, and that is the whole point: it
   * separates an account that has outgrown its tier from one that had a busy
   * week. "A spike-triggered offer is the fastest way to make this feature feel
   * like spam."
   */
  dimension?: string;
  ratio?: number;
  sustainedPeriods?: number;
  /**
   * At least this many dimensions under pressure in the latest period.
   *
   * CO-OCCURRENCE is the intelligence (D4): one dimension at 90% is a pack
   * sale, three at once is a tier that no longer fits. A single-dimension rule
   * can only ever offer the pack.
   */
  minDimensionsUnderPressure?: number;
  /** Bundles the account must already hold. */
  holdsAddons?: string[];
  /** Bundles the account must NOT hold — the "already bought it" guard. */
  lacksAddons?: string[];
  /** Minimum subscription age in days: a young account is not an expansion case. */
  minSubscriptionAgeDays?: number;
  /**
   * Refuse unless the profile is COMPLETE (D8).
   *
   * Defaults to true at the evaluation site rather than here, because a
   * condition block that omits it must still fail closed: a profile assembled
   * from partial reads looks like low usage on whichever read failed, and an
   * offer argued from it is argued from an artefact.
   */
  requireCompleteProfile?: boolean;
}

export interface PromotionConditions {
  /** Restrict to these plan tiers. */
  tiers?: string[];
  /** Restrict to these billing intervals. */
  intervals?: Array<BillingInterval>;
  /** Only the org's FIRST-ever subscription (no prior subscription doc). */
  firstSubscriptionOnly?: boolean;
  /** Usage-derived eligibility (Phase 1). Absent ⇒ no usage predicate applies. */
  usage?: PromotionUsageConditions;
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
  /**
   * The {@link CampaignDocument} this promotion belongs to — its `_id`, i.e. the
   * normalized slug, validated to EXIST at create. Carried onto each granted
   * ledger line.
   *
   * A reference, not a free label. Promotions and discount codes used to keep
   * two unrelated `campaign` strings with the same name, so one marketing push
   * run as both had two budgets, two filters and no combined view — while an
   * operator would reasonably assume one campaign. Naming a campaign here puts
   * this promotion's grants under that campaign's BUDGET and into its spend
   * rollup, alongside the codes.
   */
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
            // Usage predicates (Phase 1). All `default: undefined` so an
            // existing promotion stores no usage block at all and keeps its
            // exact current behaviour — a block of zeroes would read as
            // "requires 0 sustained periods", which matches everything.
            usage: {
              type: {
                dimension: { type: String, default: undefined },
                ratio: { type: Number, default: undefined, min: 0 },
                sustainedPeriods: { type: Number, default: undefined, min: 1 },
                minDimensionsUnderPressure: { type: Number, default: undefined, min: 1 },
                holdsAddons: { type: [String], default: undefined },
                lacksAddons: { type: [String], default: undefined },
                minSubscriptionAgeDays: { type: Number, default: undefined, min: 0 },
                requireCompleteProfile: { type: Boolean, default: undefined },
              },
              default: undefined,
              _id: false,
            },
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
