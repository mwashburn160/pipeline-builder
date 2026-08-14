// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for helpers/credit-ledger-compaction — the pure fold that bounds
 * `subscription.creditLedger`'s per-period growth. Verifies: nothing folds under
 * the keep threshold; old periodic rows fold into a per-family carry row that
 * preserves the summed cents + grant count; recent rows (idempotency) are kept;
 * one-time rows and distinct families are untouched; a prior carry row re-merges.
 */

import { describe, it, expect } from '@jest/globals';
import { compactCreditLedger, DEFAULT_KEEP_RECENT, type CreditLedgerEntry } from '../src/helpers/credit-ledger-compaction.js';

/** A periodic recurring/combo/promo row (dedupeKey = the period marker). */
function periodic(discountId: string, period: number, cents = 100): CreditLedgerEntry {
  return { discountId, cents, appliedAt: new Date(Date.UTC(2026, 0, period)), dedupeKey: `p-${period}` };
}

/** Sum a family's cents + grant count across a compacted ledger. */
function totals(ledger: CreditLedgerEntry[], discountId: string) {
  return ledger
    .filter((r) => r.discountId === discountId)
    .reduce((acc, r) => ({ cents: acc.cents + r.cents, grants: acc.grants + (r.grantCount ?? 1) }), { cents: 0, grants: 0 });
}

describe('compactCreditLedger', () => {
  it('returns the ledger unchanged when a family is at/under the keep threshold', () => {
    const rows = Array.from({ length: 3 }, (_, i) => periodic('promo:x', i + 1));
    const out = compactCreditLedger(rows, 5);
    expect(out).toEqual(rows);
    expect(out.some((r) => r.dedupeKey?.startsWith('compacted:'))).toBe(false);
  });

  it('folds rows beyond keepRecent into ONE carry row, preserving summed cents + grantCount', () => {
    const rows = Array.from({ length: 10 }, (_, i) => periodic('promo:x', i + 1, 100));
    const out = compactCreditLedger(rows, 3);

    // 10 → carry(7 folded) + 3 most-recent kept = 4 rows.
    expect(out).toHaveLength(4);
    const carry = out.filter((r) => r.dedupeKey === 'compacted:promo:x');
    expect(carry).toHaveLength(1);
    expect(carry[0]).toMatchObject({ cents: 700, grantCount: 7 });

    // The 3 kept rows are the NEWEST periods (idempotency for recent redeliveries).
    const kept = out.filter((r) => r.dedupeKey?.startsWith('p-')).map((r) => r.dedupeKey);
    expect(kept).toEqual(['p-8', 'p-9', 'p-10']);

    // Loss-less: total cents + grant count are unchanged vs the raw ledger.
    expect(totals(out, 'promo:x')).toEqual({ cents: 1000, grants: 10 });
  });

  it('is idempotent — re-compacting a compacted ledger changes nothing', () => {
    const rows = Array.from({ length: 8 }, (_, i) => periodic('promo:x', i + 1));
    const once = compactCreditLedger(rows, 3);
    const twice = compactCreditLedger(once, 3);
    expect(twice).toEqual(once);
  });

  it('re-merges a prior carry row when new periods have folded again', () => {
    const carry: CreditLedgerEntry = { discountId: 'promo:x', cents: 500, appliedAt: new Date(Date.UTC(2026, 0, 1)), dedupeKey: 'compacted:promo:x', grantCount: 5 };
    const fresh = Array.from({ length: 6 }, (_, i) => periodic('promo:x', i + 10, 100));
    const out = compactCreditLedger([carry, ...fresh], 3);

    const merged = out.filter((r) => r.dedupeKey === 'compacted:promo:x');
    expect(merged).toHaveLength(1);
    // carry(500/5) + 3 folded fresh(300/3) = 800/8, plus 3 kept fresh = 300/3.
    expect(merged[0]).toMatchObject({ cents: 800, grantCount: 8 });
    expect(totals(out, 'promo:x')).toEqual({ cents: 1100, grants: 11 });
  });

  it('never folds one-time rows (no dedupeKey) and keeps distinct families separate', () => {
    const oneTime: CreditLedgerEntry = { discountId: 'disc_abc', cents: 5000, appliedAt: new Date() };
    const promoRows = Array.from({ length: 6 }, (_, i) => periodic('promo:x', i + 1));
    const comboRows = Array.from({ length: 6 }, (_, i) => periodic('combo:y', i + 1, 200));
    const out = compactCreditLedger([oneTime, ...promoRows, ...comboRows], 2);

    // One-time row untouched.
    expect(out).toContainEqual(oneTime);
    // Each family folds independently into its own carry.
    expect(out.filter((r) => r.dedupeKey === 'compacted:promo:x')).toHaveLength(1);
    expect(out.filter((r) => r.dedupeKey === 'compacted:combo:y')).toHaveLength(1);
    expect(totals(out, 'promo:x')).toEqual({ cents: 600, grants: 6 });
    expect(totals(out, 'combo:y')).toEqual({ cents: 1200, grants: 6 });
  });

  it('exposes a sane default keep window (bounded but well beyond a redelivery window)', () => {
    expect(DEFAULT_KEEP_RECENT).toBeGreaterThanOrEqual(6);
    const rows = Array.from({ length: DEFAULT_KEEP_RECENT }, (_, i) => periodic('promo:x', i + 1));
    // At exactly the default window, nothing folds.
    expect(compactCreditLedger(rows)).toEqual(rows);
  });

  it('handles an empty ledger', () => {
    expect(compactCreditLedger([])).toEqual([]);
  });
});
