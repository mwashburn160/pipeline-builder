// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { formatPrice, DEFAULT_PLAN_ID } from '../src/components/billing/helpers';

describe('formatPrice', () => {
  it('renders 0 as "Free" (no suffix even when one is given)', () => {
    expect(formatPrice(0, 'usd')).toBe('Free');
    expect(formatPrice(0, 'usd', { suffix: '/mo' })).toBe('Free');
  });

  it('formats cents as a dollar amount', () => {
    expect(formatPrice(999, 'usd')).toBe('$9.99');
  });

  it('formats in the currency the billing response names, not dollars', () => {
    expect(formatPrice(4900, 'eur')).toBe('€49.00');
    // Zero-decimal: a yen price is whole units.
    expect(formatPrice(4900, 'jpy')).toBe('¥4,900');
  });

  it('appends the suffix for non-zero prices', () => {
    expect(formatPrice(999, 'usd', { suffix: '/mo' })).toBe('$9.99/mo');
  });
});

describe('DEFAULT_PLAN_ID', () => {
  it('is the developer (free) tier slug', () => {
    expect(DEFAULT_PLAN_ID).toBe('developer');
  });
});
