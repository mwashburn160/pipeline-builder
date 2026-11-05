// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The DO-NOT-OFFER list (docs/plans/sales-agent.md D6).
 *
 * "The veto is the price of shipping this at all." Somebody will know something
 * the signals cannot: an account in contract negotiation, a strategic account
 * whose pricing a person is handling, an account being actively saved. Without a
 * way to say "not this one", the first awkward offer becomes an argument for
 * switching the whole feature off — and that argument wins, because it is
 * correct.
 *
 * SEPARATE from the account's own `offersEnabled`, and not a way to set it. One
 * is the customer's statement and the other is ours; folding them together would
 * mean an operator's veto could be undone by a customer toggling a switch, and
 * that an account that opted out would appear on an internal exclusion list it
 * never asked to be on.
 *
 * A REASON is required rather than optional. A bare list of org ids goes stale
 * the moment the person who added them leaves, and then nobody can tell an
 * expired negotiation from a permanent exclusion — so the row carries why and
 * who, and the admin surface shows both.
 */

import mongoose, { Schema } from 'mongoose';

export interface OfferExclusionDocument extends mongoose.Document {
  /** The ACCOUNT root. Offers are made to accounts, so vetoes are too. */
  orgId: string;
  reason: string;
  /** Who added it — an actor id, as every other audited write here records. */
  actorId: string;
  createdAt: Date;
  updatedAt: Date;
}

const offerExclusionSchema = new Schema<OfferExclusionDocument>(
  {
    orgId: { type: String, required: true },
    reason: { type: String, required: true, maxlength: 500 },
    actorId: { type: String, required: true },
  },
  { collection: 'offer_exclusions', timestamps: true },
);

/** One veto per account: adding it twice updates the reason rather than listing it twice. */
offerExclusionSchema.index({ orgId: 1 }, { unique: true });

export const OfferExclusion =
  (mongoose.models.OfferExclusion as mongoose.Model<OfferExclusionDocument>) ||
  mongoose.model<OfferExclusionDocument>('OfferExclusion', offerExclusionSchema);
