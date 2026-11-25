// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Credit-ledger compaction — bounds the growth of `subscription.creditLedger`.
 *
 * The periodic re-grant paths (recurring discount + combo credits in
 * discount-helpers.grantPeriodicCredits, recurring promotions in
 * promotion-engine.grantRecurringPromotions) append ONE row per rule per billing
 * period, forever. Left unbounded the array both grows without limit and is
 * O(n)-scanned on every grant's idempotency check. This is the ledger analogue of
 * the per-hour → per-period roll-up the Marketplace drawdown already does
 * (billing-ledger.recordMarketplaceConsumption).
 *
 * The fold is loss-LESS for the two things that read the ledger as a source of
 * truth:
 *   - promotion-spend reconcile (promotion-engine.reconcilePromotionSpend) sums
 *     `cents` and counts grants across `promo:<id>` rows → a carry row preserves
 *     the summed `cents` and a `grantCount` so both stay exact.
 *   - the ALREADY_REDEEMED / recurring-active checks match on `discountId`, which
 *     the carry row keeps.
 *
 * Idempotency is preserved because only rows OLDER than the most-recent
 * `keepRecent` per family are folded: a redelivered webhook / repeated cycle for a
 * recent period still finds its per-period `dedupeKey` row. `keepRecent` is sized
 * far above any provider redelivery window (Stripe retries for ~3 days; a
 * period is a month/year), so a real re-grant is never mis-detected as new.
 */

/** One usage-credit provenance row (mirrors the Subscription.creditLedger shape). */
export interface CreditLedgerEntry {
  discountId: string;
  cents: number;
  appliedAt: Date;
  fulfillmentRef?: { kind: string; ref: string };
  dedupeKey?: string;
  /** Present only on a compaction carry row: number of folded grants. */
  grantCount?: number;
  /** The campaign the granting discount belonged to (campaign spend reporting). */
  campaign?: string;
  /** Set on a promotion clawback tombstone (see clawbackRecentPromotions). */
  clawedBackAt?: Date;
  /** The reversal that clawed this row back (`dispute:<id>`), when tagged. */
  clawbackRef?: string;
  /** The cents that clawback recovered (re-granted if the dispute is won). */
  clawedBackCents?: number;
}

/**
 * Build a credit-ledger row. Single source of the row SHAPE so the discount and
 * promotion grant paths' atomic `$push` sites can't drift (add a field to one,
 * forget the others). Stamps `appliedAt`
 * at call time; callers supply the provenance + amount.
 */
export function creditLedgerEntry(e: {
  discountId: string;
  cents: number;
  fulfillmentRef?: { kind: string; ref: string };
  dedupeKey?: string;
  /** The campaign the granting discount belongs to, so campaign spend is one
   *  query over the ledger instead of a join back through discount records. */
  campaign?: string;
}): CreditLedgerEntry {
  return { discountId: e.discountId, cents: e.cents, appliedAt: new Date(), fulfillmentRef: e.fulfillmentRef, dedupeKey: e.dedupeKey, campaign: e.campaign };
}

/** Default number of most-recent periodic rows to keep per provenance family
 *  before folding the remainder. One year of monthly periods — comfortably beyond
 *  any provider webhook-redelivery window, so recent-period idempotency is intact. */
export const DEFAULT_KEEP_RECENT = 12;

/** Dedupe-key marker of a compaction carry row (never collides with a periodKey). */
const COMPACTED_PREFIX = 'compacted:';

/** Whether a row is a periodic re-grant eligible for folding — it carries a
 *  `dedupeKey` and is not itself an existing carry row. One-time grants (no
 *  dedupeKey) are never folded. */
function isPeriodic(entry: CreditLedgerEntry): boolean {
  return typeof entry.dedupeKey === 'string' && !entry.dedupeKey.startsWith(COMPACTED_PREFIX);
}

/** Grants a row represents — 1 for an ordinary row, its stored count for a carry. */
function grantsOf(entry: CreditLedgerEntry): number {
  return entry.grantCount ?? 1;
}

/**
 * The fold family of a row: its `discountId` AND its `campaign`. The campaign
 * spend rollup (campaign.aggregateCampaignLedgerSpend) reads the ledger by
 * `campaign`, so a carry row must keep it — and rows of one discountId stamped
 * with different campaigns must fold into separate carries, or one campaign's
 * spend would be reported under the other.
 */
function familyOf(entry: CreditLedgerEntry): string {
  return entry.campaign ? `${entry.discountId}#${entry.campaign}` : entry.discountId;
}

/**
 * The raw collection calls {@link compactStoredCreditLedger} needs. Structural, so
 * this module stays free of the model layer: callers pass `Subscription.collection`.
 */
export interface LedgerCollection {
  findOne(filter: { _id: unknown }, options: { projection: { creditLedger: 1 } }): Promise<{ creditLedger?: CreditLedgerEntry[] } | null>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ modifiedCount: number }>;
}

/**
 * Compact the STORED ledger of one subscription. Every grant writes the ledger
 * atomically (`$push` / positional `$set`), so a compaction cannot read, fold
 * and save the document — that would clobber a grant or a clawback tombstone
 * written in between. Instead it is a compare-and-set on the whole array: read
 * the raw ledger, fold it ({@link compactCreditLedger}), and replace it only
 * where it still equals exactly what was read. A concurrent write makes the
 * filter miss and nothing is written; the next period's pass folds it then.
 * Runs on the raw collection so the read and the filter are the same BSON,
 * with no schema casting between them. Returns whether it wrote.
 */
export async function compactStoredCreditLedger(
  collection: LedgerCollection,
  subscriptionId: unknown,
  keepRecent: number = DEFAULT_KEEP_RECENT,
): Promise<boolean> {
  const doc = await collection.findOne({ _id: subscriptionId }, { projection: { creditLedger: 1 } });
  const ledger = doc?.creditLedger ?? [];
  const compacted = compactCreditLedger(ledger, keepRecent);
  if (compacted.length === ledger.length) return false;
  const result = await collection.updateOne({ _id: subscriptionId, creditLedger: ledger }, { $set: { creditLedger: compacted } });
  return result.modifiedCount === 1;
}

/**
 * Return a compacted copy of `ledger`: within each family (`discountId` + `campaign`,
 * see {@link familyOf}), keep the
 * most-recent `keepRecent` periodic rows (by `appliedAt`) and fold the rest —
 * together with any prior carry row for that family — into a single carry row
 * (`dedupeKey: 'compacted:<family>'`, keeping the family's `campaign`) whose
 * `cents`/`grantCount` are the sums.
 * Non-periodic rows (one-time grants, existing carry rows for families under the
 * threshold) pass through untouched. Order-preserving for the untouched rows; the
 * carry row is appended at the family's first-seen position. Pure — no mutation of
 * the input.
 */
export function compactCreditLedger(
  ledger: readonly CreditLedgerEntry[],
  keepRecent: number = DEFAULT_KEEP_RECENT,
): CreditLedgerEntry[] {
  if (ledger.length === 0) return [];
  const keep = Math.max(1, keepRecent);

  // Group the foldable (periodic + existing-carry) rows by family so we can decide
  // per family whether anything needs folding.
  const periodicByFamily = new Map<string, CreditLedgerEntry[]>();
  const carryByFamily = new Map<string, CreditLedgerEntry[]>();
  for (const entry of ledger) {
    if (isPeriodic(entry)) {
      const list = periodicByFamily.get(familyOf(entry)) ?? [];
      list.push(entry);
      periodicByFamily.set(familyOf(entry), list);
    } else if (entry.dedupeKey?.startsWith(COMPACTED_PREFIX)) {
      const list = carryByFamily.get(familyOf(entry)) ?? [];
      list.push(entry);
      carryByFamily.set(familyOf(entry), list);
    }
  }

  // Families that actually need work: more than `keep` periodic rows. A family at
  // or under the threshold is left as-is (an existing carry row for it passes
  // through untouched) so compaction is IDEMPOTENT; when the family later grows
  // past the threshold, any prior carry is folded back in below.
  const foldFamilies = new Set<string>();
  for (const [family, rows] of periodicByFamily) {
    if (rows.length > keep) foldFamilies.add(family);
  }
  if (foldFamilies.size === 0) return [...ledger];

  // Per family, pick the newest `keep` periodic rows to retain; everything else
  // (older periodic rows + prior carry) folds into the new carry totals.
  const retain = new Set<CreditLedgerEntry>();
  const carryTotals = new Map<string, { discountId: string; campaign?: string; cents: number; grantCount: number; appliedAt: Date }>();
  for (const family of foldFamilies) {
    const rows = [...(periodicByFamily.get(family) ?? [])]
      .sort((a, b) => new Date(a.appliedAt).getTime() - new Date(b.appliedAt).getTime());
    const kept = rows.slice(Math.max(0, rows.length - keep));
    for (const r of kept) retain.add(r);
    const folded = rows.slice(0, Math.max(0, rows.length - keep));
    let cents = 0; let grantCount = 0; let appliedAt = new Date(0);
    for (const r of [...folded, ...(carryByFamily.get(family) ?? [])]) {
      cents += r.cents;
      grantCount += grantsOf(r);
      const t = new Date(r.appliedAt);
      if (t.getTime() > appliedAt.getTime()) appliedAt = t;
    }
    if (grantCount > 0) carryTotals.set(family, { discountId: rows[0].discountId, campaign: rows[0].campaign, cents, grantCount, appliedAt });
  }

  const out: CreditLedgerEntry[] = [];
  const emittedCarry = new Set<string>();
  for (const entry of ledger) {
    const family = familyOf(entry);
    if (isPeriodic(entry)) {
      if (retain.has(entry)) { out.push(entry); continue; }
      if (!foldFamilies.has(family)) { out.push(entry); continue; }
      // Folded — emit the family's carry row once, at the position of its first
      // folded row, so provenance stays where the history was.
      if (!emittedCarry.has(family)) {
        const totals = carryTotals.get(family)!;
        out.push({
          discountId: totals.discountId,
          cents: totals.cents,
          appliedAt: totals.appliedAt,
          dedupeKey: `${COMPACTED_PREFIX}${family}`,
          grantCount: totals.grantCount,
          ...(totals.campaign ? { campaign: totals.campaign } : {}),
        });
        emittedCarry.add(family);
      }
      continue;
    }
    // Existing carry row: drop it if its family folded (rolled into the new carry),
    // otherwise pass through.
    if (entry.dedupeKey?.startsWith(COMPACTED_PREFIX) && foldFamilies.has(family)) continue;
    out.push(entry);
  }
  return out;
}
