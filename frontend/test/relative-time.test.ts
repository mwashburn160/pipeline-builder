// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatRelativeTime } from '../src/lib/relative-time';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00:00Z

describe('formatRelativeTime', () => {
  it('returns "just now" within 30 seconds', () => {
    expect(formatRelativeTime(NOW - 5_000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW + 10_000, NOW)).toBe('just now');
  });

  it('returns minutes for sub-hour deltas', () => {
    const out = formatRelativeTime(NOW - 5 * 60_000, NOW);
    // Locale string output varies by Node version but always contains "min" + "5"
    expect(out.toLowerCase()).toMatch(/5/);
    expect(out.toLowerCase()).toMatch(/min/);
  });

  it('returns hours for sub-day deltas', () => {
    const out = formatRelativeTime(NOW - 3 * 60 * 60_000, NOW);
    expect(out).toMatch(/3/);
    expect(out.toLowerCase()).toMatch(/hr|hour/);
  });

  it('returns days for sub-month deltas', () => {
    const out = formatRelativeTime(NOW - 5 * 24 * 60 * 60_000, NOW);
    expect(out).toMatch(/5/);
    expect(out.toLowerCase()).toMatch(/day/);
  });

  it('returns absolute date for >30 days', () => {
    const out = formatRelativeTime(NOW - 60 * 24 * 60 * 60_000, NOW);
    // toLocaleDateString output, but must NOT match relative pattern
    expect(out).not.toMatch(/ago|day|hour/i);
    // Should contain a year (e.g., '2026' or '/26' or similar)
    expect(out).toMatch(/\d{2,4}/);
  });

  it('handles ISO string inputs', () => {
    const isoTime = new Date(NOW - 60_000).toISOString();
    const out = formatRelativeTime(isoTime, NOW);
    expect(out.toLowerCase()).toMatch(/min|sec|just/);
  });

  it('handles Date object inputs', () => {
    const dateInput = new Date(NOW - 60_000);
    const out = formatRelativeTime(dateInput, NOW);
    expect(out.toLowerCase()).toMatch(/min|sec|just/);
  });

  it('returns empty string for invalid input', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
    expect(formatRelativeTime(NaN, NOW)).toBe('');
  });
});
