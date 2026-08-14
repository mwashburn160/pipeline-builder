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
 * Return a compacted copy of `ledger`: within each `discountId` family, keep the
 * most-recent `keepRecent` periodic rows (by `appliedAt`) and fold the rest —
 * together with any prior carry row for that family — into a single carry row
 * (`dedupeKey: 'compacted:<discountId>'`) whose `cents`/`grantCount` are the sums.
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
      const list = periodicByFamily.get(entry.discountId) ?? [];
      list.push(entry);
      periodicByFamily.set(entry.discountId, list);
    } else if (entry.dedupeKey?.startsWith(COMPACTED_PREFIX)) {
      const list = carryByFamily.get(entry.discountId) ?? [];
      list.push(entry);
      carryByFamily.set(entry.discountId, list);
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
  const carryTotals = new Map<string, { cents: number; grantCount: number; appliedAt: Date }>();
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
    if (grantCount > 0) carryTotals.set(family, { cents, grantCount, appliedAt });
  }

  const out: CreditLedgerEntry[] = [];
  const emittedCarry = new Set<string>();
  for (const entry of ledger) {
    const family = entry.discountId;
    if (isPeriodic(entry)) {
      if (retain.has(entry)) { out.push(entry); continue; }
      if (!foldFamilies.has(family)) { out.push(entry); continue; }
      // Folded — emit the family's carry row once, at the position of its first
      // folded row, so provenance stays where the history was.
      if (!emittedCarry.has(family)) {
        const totals = carryTotals.get(family)!;
        out.push({ discountId: family, cents: totals.cents, appliedAt: totals.appliedAt, dedupeKey: `${COMPACTED_PREFIX}${family}`, grantCount: totals.grantCount });
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
