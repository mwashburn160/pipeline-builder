// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatPrice, DEFAULT_PLAN_ID, formatDate } from '../src/components/billing/helpers';

describe('formatPrice', () => {
  it('renders 0 as "Free" (no suffix even when one is given)', () => {
    expect(formatPrice(0)).toBe('Free');
    expect(formatPrice(0, { suffix: '/mo' })).toBe('Free');
  });

  it('formats cents as a dollar amount', () => {
    expect(formatPrice(999)).toBe('$9.99');
  });

  it('appends the suffix for non-zero prices', () => {
    expect(formatPrice(999, { suffix: '/mo' })).toBe('$9.99/mo');
  });
});

describe('DEFAULT_PLAN_ID', () => {
  it('is the developer (free) tier slug', () => {
    expect(DEFAULT_PLAN_ID).toBe('developer');
  });
});

describe('formatDate', () => {
  it('formats an ISO date as a localized long date', () => {
    expect(formatDate('2026-02-25T00:00:00Z')).toMatch(/2026/);
  });
});
