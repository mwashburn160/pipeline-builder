// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 6 — measurement (docs/plans/sales-agent.md).
 *
 * "Expansion revenue is the easiest thing in a product to claim and the hardest
 * to prove." Three things here, and each exists because the feature would
 * otherwise be unfalsifiable:
 *
 * 1. **Conversion ATTRIBUTION** (`attributeConversion`). An offer only becomes a
 *    conversion when the account actually buys, and the purchase happens on the
 *    ordinary add-on / plan-change routes — which know nothing about offers. So
 *    those routes call in here, and this decides whether an open offer was
 *    plausibly the cause.
 *
 * 2. **Offered-SKU against bought-SKU.** The second of the two measures that
 *    decide whether the targeting is right rather than merely active: an
 *    account that converts to a DIFFERENT SKU is a targeting failure wearing a
 *    conversion win. Collapsing them into one "conversions" counter is how a
 *    badly-targeted feature reports success.
 *
 * 3. **The EXPIRY sweep** (`sweepExpiredOffers`). Without it `expired` is never
 *    recorded at all: an offer nobody answers just sits as `sent` forever, which
 *    silently inflates the open-offer count and blocks the account's next slot
 *    past the quiet period.
 *
 * The LIFT comparison (`measureLift`) is deliberately arithmetic over rows
 * rather than a stored aggregate: the holdout's whole value is that it was
 * decided before any rule ran, and a cached number is one that can be computed
 * once, wrongly, and then trusted.
 */

import { createLogger, emitCounter, errorMessage } from '@pipeline-builder/api-core';
import { Offer, type OfferType } from '../models/offer.js';

const logger = createLogger('offers-outcome');

/**
 * How long after a send a purchase may still be credited to the offer.
 *
 * Tied to the offer's own `expiresAt` when it has one; this is the ceiling for
 * one that does not. Deliberately not generous: a purchase three months after a
 * dismissed suggestion is not evidence the suggestion worked, and crediting it
 * would make the lift number flatter and friendlier than the truth.
 */
export const ATTRIBUTION_WINDOW_DAYS = 30;

/** What an account bought, in the vocabulary the offer was made in. */
export interface Purchase {
  /** `tier` for a plan change, `bundle` for an add-on. */
  kind: 'tier' | 'bundle';
  /** The tier id or bundle id. */
  sku: string;
}

/**
 * Credit a purchase to this account's open offer, if there is one it fits.
 *
 * BEST EFFORT and never thrown: it runs inside a purchase the customer has
 * already completed, and failing their add-on change because a measurement row
 * could not be written would be the worst possible trade.
 *
 * A DISMISSED offer still converts. Dismissal hides the card, it does not say
 * no — and an account that dismissed a suggestion and bought the thing a week
 * later is exactly the case the lift measurement needs to see. A DECLINED one
 * does not: it said no, and crediting the purchase anyway would let the feature
 * claim the conversions it was explicitly refused.
 */
export async function attributeConversion(orgId: string, purchase: Purchase, now: Date = new Date()): Promise<boolean> {
  try {
    const cutoff = new Date(now.getTime() - ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const offer = await Offer.findOne({
      orgId,
      status: 'sent',
      sentAt: { $gte: cutoff },
    }).sort({ sentAt: -1 });
    if (!offer || !offer.sentAt) return false;
    // Past its own expiry is not a conversion, even inside the window above:
    // the account was told the offer had lapsed.
    if (offer.expiresAt && offer.expiresAt < now) return false;

    const conversionMs = now.getTime() - offer.sentAt.getTime();
    offer.status = 'redeemed';
    offer.resolvedAt = now;
    offer.boughtSku = purchase.sku;
    offer.conversionMs = conversionMs;
    await offer.save();

    const match = skuMatch(offer.offerType, offer.targetTier ?? null, purchase);
    emitCounter('billing_offer_conversions_total', {
      type: offer.offerType,
      holdout: String(offer.holdout),
      // `match` is the whole point: a conversion to something else is a
      // targeting failure, and a single counter would hide it.
      match,
      bucket: timeBucket(conversionMs),
    });
    logger.info('Offer converted', { orgId, type: offer.offerType, match, conversionMs });
    return true;
  } catch (err) {
    logger.warn('Could not attribute a conversion to an offer', { orgId, error: errorMessage(err) });
    return false;
  }
}

/**
 * Did the account buy what it was offered?
 *
 * `exact` for a tier offer answered by that tier. `kind` for a purchase of the
 * right SHAPE but a different SKU — a pack offer answered by some other pack,
 * which is a near miss rather than a failure, since the offer was about capacity
 * and capacity is what they bought. `other` for anything else, which is the
 * reading worth acting on.
 */
export function skuMatch(offerType: OfferType, targetTier: string | null, purchase: Purchase): 'exact' | 'kind' | 'other' {
  if (offerType === 'upgrade') {
    if (purchase.kind !== 'tier') return 'other';
    return targetTier && purchase.sku === targetTier ? 'exact' : 'kind';
  }
  // A pack or a basket is answered by buying capacity. The offer does not name
  // one bundle id today — the cheapest pack is quoted in the copy, not stored
  // as a target — so a bundle purchase is `kind` rather than `exact`, and
  // saying `exact` would claim a precision the record does not have.
  return purchase.kind === 'bundle' ? 'kind' : 'other';
}

/** Coarse time-to-conversion buckets, so the counter stays low-cardinality. */
export function timeBucket(ms: number): string {
  const days = ms / (24 * 60 * 60 * 1000);
  if (days < 1) return 'same_day';
  if (days < 7) return 'within_week';
  if (days < 14) return 'within_2w';
  return 'later';
}

/**
 * Close offers whose clock has run out.
 *
 * Two reasons this is not optional. The obvious one: `expired` is a status the
 * measurement counts, and nothing else ever sets it. The load-bearing one: the
 * account's own surface shows any `sent` offer, so an unanswered one would stay
 * on the billing page indefinitely — a suggestion that outlives the prices it
 * quoted.
 */
export async function sweepExpiredOffers(now: Date = new Date()): Promise<number> {
  try {
    const result = await Offer.updateMany(
      { status: 'sent', expiresAt: { $lt: now } },
      { $set: { status: 'expired', resolvedAt: now } },
    );
    const n = result.modifiedCount ?? 0;
    if (n > 0) {
      emitCounter('billing_offers_expired_total', {}, n);
      logger.info('Expired offers swept', { count: n });
    }
    return n;
  } catch (err) {
    logger.warn('Offer expiry sweep failed', { error: errorMessage(err) });
    return 0;
  }
}

export interface LiftArm {
  /** Accounts in this arm that the cycle has decided on at least once. */
  accounts: number;
  /** Offers actually sent (zero for the holdout, by construction). */
  sent: number;
  conversions: number;
  /** Conversions ÷ accounts, 0–1. The figure the comparison turns on. */
  conversionRate: number;
}

export interface LiftReport {
  offered: LiftArm;
  holdout: LiftArm;
  /** `offered.conversionRate - holdout.conversionRate`. Can be NEGATIVE. */
  lift: number;
  /** Conversions by whether the account bought what it was offered. */
  skuMatch: Record<string, number>;
  /** Conversions by time-to-conversion bucket. */
  timeToConversion: Record<string, number>;
}

/**
 * Offered against holdout, on conversion rate.
 *
 * Counted per ACCOUNT rather than per row, because an account with four
 * suppression rows and one offer is one account in one arm — counting rows would
 * weight the comparison by how often the cycle happened to look at someone.
 *
 * The lift can come out NEGATIVE and that is a legitimate answer: it means the
 * accounts we solicited converted less than the ones we left alone, which is the
 * finding the holdout exists to be able to produce. Nothing here clamps it.
 *
 * It does NOT compare revenue per account, which the plan also asks for: that
 * needs the subscription's price at conversion, which this collection does not
 * hold, and inventing it from today's catalogue would mis-state the one number
 * the exercise is for. Conversion rate is the honest half.
 */
export async function measureLift(): Promise<LiftReport> {
  const [arms, matches, buckets] = await Promise.all([
    Offer.aggregate<{ _id: boolean; accounts: string[]; sent: number; conversions: number }>([
      {
        $group: {
          _id: '$holdout',
          accounts: { $addToSet: '$orgId' },
          sent: { $sum: { $cond: [{ $ifNull: ['$sentAt', false] }, 1, 0] } },
          conversions: { $sum: { $cond: [{ $eq: ['$status', 'redeemed'] }, 1, 0] } },
        },
      },
    ]),
    Offer.aggregate<{ _id: string | null; count: number }>([
      { $match: { status: 'redeemed' } },
      { $group: { _id: '$boughtSku', count: { $sum: 1 } } },
    ]),
    // Read the raw elapsed times and bucket them HERE rather than grouping on
    // `$conversionMs` in the pipeline: that field is a millisecond value, so a
    // `$group` on it produces one group per distinct conversion — a cardinality
    // explosion dressed up as an aggregate.
    Offer.find({ conversionMs: { $exists: true } }).select('conversionMs').lean(),
  ]);

  const arm = (holdout: boolean): LiftArm => {
    const row = arms.find((a) => a._id === holdout);
    const accounts = row?.accounts.length ?? 0;
    const conversions = row?.conversions ?? 0;
    return {
      accounts,
      sent: row?.sent ?? 0,
      conversions,
      // Zero accounts means "no answer yet", reported as 0 rather than NaN —
      // a NaN in this field reads as a broken page rather than an empty one.
      conversionRate: accounts > 0 ? conversions / accounts : 0,
    };
  };

  const offered = arm(false);
  const holdout = arm(true);
  const timeToConversion: Record<string, number> = {};
  for (const row of buckets) {
    if (typeof row.conversionMs !== 'number') continue;
    const key = timeBucket(row.conversionMs);
    timeToConversion[key] = (timeToConversion[key] ?? 0) + 1;
  }

  return {
    offered,
    holdout,
    lift: offered.conversionRate - holdout.conversionRate,
    skuMatch: Object.fromEntries(matches.map((m) => [m._id ?? 'unknown', m.count])),
    timeToConversion,
  };
}
