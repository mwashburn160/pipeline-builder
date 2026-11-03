// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document } from 'mongoose';

// Types

/**
 * A discount CAMPAIGN: the identity that a set of codes belongs to, with the
 * budget, window and one-per-account rule that apply across the whole set.
 *
 * `Discount.campaign` used to be a free-form label — indexed and filterable, and
 * nothing else. That made four things impossible at once, all of which the
 * sibling `Promotion` already had:
 *
 *  - **A budget.** The mint ceilings bound ONE coupon and `maxRedemptions` bounds
 *    one code's redemptions; nothing bounded the set. Fifty codes at $500 with
 *    100 redemptions each was a $2.5M exposure no guard could see.
 *  - **One per account.** `maxRedemptions` is global and the once-per-org rule
 *    binds per discount id, so an account could redeem every code in a "pick one
 *    of these five" campaign. A per-CODE exclusivity flag could not fix it: one
 *    unflagged code was a bypass, and redemption ORDER changed the answer.
 *  - **Attribution.** Promotions stamp their campaign onto every granted ledger
 *    line; discount rows carried only `discountId`, so "what did this campaign
 *    cost?" meant joining ledger rows back through discount records.
 *  - **A typo-proof name.** Any string created a campaign, so `summer-26` was
 *    silently a different campaign from `summer26` — breaking the filter AND,
 *    worse, silently not matching for exclusivity.
 *
 * `_id` IS the normalized slug (see `helpers/campaign.ts`), so a discount
 * references a campaign by the same value it reports, and a campaign that does
 * not exist cannot be referenced. `spentCents` / `grantsCount` are a reconciled
 * ADVISORY cache in the same sense as `Promotion`'s: the credit ledger (rows
 * carrying this campaign) is the source of truth for spend.
 */
export interface CampaignDocument extends Document<string> {
  /** The normalized slug — also what `Discount.campaign` stores. */
  _id: string;
  /** Display name for the console (the slug is the key, this is the label). */
  name: string;
  /**
   * Total cents this campaign may give away across every code in it;
   * absent = unlimited. Committed on redemption (reserved, then released if the
   * redemption fails), so concurrent redemptions cannot overshoot it.
   */
  budgetCents?: number;
  /** Reconciled advisory cache of committed spend (authority = the ledger). */
  spentCents: number;
  /** Reconciled advisory count of redemptions across the campaign. */
  grantsCount: number;
  /**
   * One redemption per account across the WHOLE campaign: an org that has
   * redeemed any code here is refused the rest. Lives on the campaign, not the
   * code, so it cannot be half-applied and does not depend on redemption order.
   */
  exclusive?: boolean;
  /** Redemption window; an absent bound is open-ended on that side. */
  startsAt?: Date;
  endsAt?: Date;
  /** False stops redemption of EVERY code in the campaign at once. */
  isActive: boolean;
  /** JWT `sub` of the system admin who created it. */
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Schema

const campaignSchema = new Schema<CampaignDocument>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    budgetCents: { type: Number, default: undefined, min: 1 },
    spentCents: { type: Number, default: 0, min: 0 },
    grantsCount: { type: Number, default: 0, min: 0 },
    exclusive: { type: Boolean, default: undefined },
    startsAt: { type: Date, default: undefined },
    endsAt: { type: Date, default: undefined },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: undefined },
  },
  {
    collection: 'discount_campaigns',
    timestamps: true,
    // `_id` is the normalized slug, not a Mongo ObjectId.
    _id: false,
  },
);

// Admin console list: active campaigns, newest first.
campaignSchema.index({ isActive: 1, createdAt: -1 });

// Model (safe for re-registration in tests)

export const Campaign =
  (mongoose.models.Campaign as mongoose.Model<CampaignDocument>) ||
  mongoose.model<CampaignDocument>('Campaign', campaignSchema);
