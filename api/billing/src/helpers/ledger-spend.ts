// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Spend read off the credit ledger — the AUTHORITY that every advisory
 * `spentCents` / `grantsCount` cache is reconciled against.
 *
 * One aggregation, because there were two identical ones: the promotion engine
 * summed rows whose `discountId` carried its `promo:<id>` handle, and the
 * campaign rollup summed rows carrying a `campaign`. Same `$unwind` / `$match` /
 * `$group`, same `grantCount` handling for folded carry rows, two copies — so a
 * fix to one (the carry-row count is easy to get wrong) could miss the other.
 */

import { Subscription } from '../models/subscription.js';

/** Totals for one grouping of ledger rows. */
export interface LedgerSpend {
  cents: number;
  /** Grants, counting a compaction carry row as the rows it folded, not as one. */
  grants: number;
}

/**
 * Sum the ledger rows matching `rowMatch`.
 *
 * `rowMatch` is expressed against the UNWOUND row, with the `creditLedger.`
 * prefix — e.g. `{ 'creditLedger.campaign': 'summer26' }`, or
 * `{ 'creditLedger.discountId': 'promo:abc' }`. Taking a filter rather than an id
 * is what lets one function serve both groupings: a promotion identifies its rows
 * by the provenance handle in `discountId`, a campaign by its own field.
 */
export async function aggregateLedgerSpend(rowMatch: Record<string, unknown>): Promise<LedgerSpend> {
  const agg = await Subscription.aggregate([
    { $unwind: '$creditLedger' },
    { $match: rowMatch },
    {
      $group: {
        _id: null,
        cents: { $sum: '$creditLedger.cents' },
        // A carry row stands for the `grantCount` periodic grants compaction
        // folded into it; an ordinary row has no `grantCount` and counts as 1.
        grants: { $sum: { $ifNull: ['$creditLedger.grantCount', 1] } },
      },
    },
  ]);
  return { cents: agg[0]?.cents ?? 0, grants: agg[0]?.grants ?? 0 };
}
