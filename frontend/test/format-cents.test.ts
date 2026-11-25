// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `formatCents` takes the billing ledger's MINOR units (the provider's integer
 * amount) in the ledger's currency. Not every currency has 100 minor units: a
 * zero-decimal currency's amount is already whole units, a three-decimal one's
 * is thousandths.
 */

import { describe, it, expect } from '@jest/globals';
import { formatCents } from '../src/lib/format';

describe('formatCents', () => {
  it('formats two-decimal currencies from cents, USD by default', () => {
    expect(formatCents(123450)).toBe('$1,234.50');
    expect(formatCents(3000, 'eur')).toBe('€30.00');
  });

  it('reads a zero-decimal currency amount as whole units', () => {
    expect(formatCents(3000, 'jpy')).toBe('¥3,000');
    expect(formatCents(15000, 'KRW')).toBe('₩15,000');
  });

  it('reads a three-decimal currency amount as thousandths', () => {
    expect(formatCents(12340, 'kwd')).toMatch(/^KWD\s12\.340$/);
  });
});
