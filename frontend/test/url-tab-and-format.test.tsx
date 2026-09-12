// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Consistency fixes:
 *  - `useUrlTab` puts tab state in the query string, so a compliance view or a
 *    reports sub-tab can be linked, refreshed and reached with browser Back.
 *  - `formatTime` completes the shared date trio; ~20 surfaces hand-rolled
 *    `toLocaleString()` and drifted into date-only / time-only / date+time for
 *    the same kind of column.
 */

import { renderHook, act } from '@testing-library/react';
import { useUrlTab } from '../src/hooks/useUrlTab';
import { formatDate, formatDateTime, formatTime } from '../src/lib/format';

const replace = jest.fn();
let query: Record<string, string> = {};

jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query, pathname: '/dashboard/compliance', replace }),
}));

const TABS = ['overview', 'rules', 'scans'] as const;

describe('useUrlTab', () => {
  beforeEach(() => { query = {}; replace.mockClear(); });

  it('falls back when the URL names no tab', () => {
    const { result } = renderHook(() => useUrlTab('view', TABS, 'overview'));
    expect(result.current[0]).toBe('overview');
  });

  it('hydrates from the URL, so a shared link opens the right view', () => {
    query = { view: 'scans' };
    const { result } = renderHook(() => useUrlTab('view', TABS, 'overview'));
    expect(result.current[0]).toBe('scans');
  });

  it('ignores an unknown value rather than showing an unknown view', () => {
    query = { view: 'not-a-tab' };
    const { result } = renderHook(() => useUrlTab('view', TABS, 'overview'));
    expect(result.current[0]).toBe('overview');
  });

  it('writes the selection back to the URL (shallow, preserving other params)', () => {
    query = { org: 'acme' };
    const { result } = renderHook(() => useUrlTab('view', TABS, 'overview'));
    act(() => result.current[1]('rules'));

    expect(result.current[0]).toBe('rules');
    expect(replace).toHaveBeenCalledWith(
      { query: { org: 'acme', view: 'rules' } },
      undefined,
      { shallow: true },
    );
  });
});

describe('shared date formatters', () => {
  const iso = '2026-03-04T15:30:00.000Z';

  it('formats date+time, date-only and time-only from one place', () => {
    expect(formatDateTime(iso)).toBe(new Date(iso).toLocaleString());
    expect(formatDate(iso)).toBe(new Date(iso).toLocaleDateString());
    expect(formatTime(iso)).toBe(new Date(iso).toLocaleTimeString());
  });

  it('renders one placeholder for missing values (not "--" / "N/A" per screen)', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatTime('')).toBe('—');
  });

  it('never renders "Invalid Date"', () => {
    expect(formatDateTime('nonsense')).toBe('—');
    expect(formatTime('nonsense')).toBe('—');
  });

  it('accepts a caller-supplied placeholder (logs keep the raw value)', () => {
    expect(formatDateTime('nonsense', 'nonsense')).toBe('nonsense');
  });
});
