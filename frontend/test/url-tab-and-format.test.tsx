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

import { renderHook, act, waitFor } from '@testing-library/react';
import { useUrlTab } from '../src/hooks/useUrlTab';
import { formatDate, formatDateTime, formatTime, formatDuration, formatDurationSeconds } from '../src/lib/format';

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
      { query: { org: 'acme', view: 'rules' }, hash: '' },
      undefined,
      { shallow: true },
    );
  });

  // A deep link names a tab AND a section on it — `?tab=factors#passkeys`. Both
  // halves have to survive, or the enrolment prompts that use them land on a
  // page that doesn't show what they promised.
  describe('fragments', () => {
    afterEach(() => { window.location.hash = ''; });

    it('opens the tab that owns the fragment when the URL names no tab', () => {
      window.location.hash = '#scan-detail';
      const { result } = renderHook(() => useUrlTab('view', TABS, 'overview', {
        hashTabs: { 'scan-detail': 'scans' },
      }));
      expect(result.current[0]).toBe('scans');
    });

    it('keeps the fragment while the user stays on the tab that owns it', () => {
      window.location.hash = '#scan-detail';
      const { result } = renderHook(() => useUrlTab('view', TABS, 'overview', {
        hashTabs: { 'scan-detail': 'scans' },
      }));
      act(() => result.current[1]('scans'));
      expect(replace).toHaveBeenCalledWith(
        { query: { view: 'scans' }, hash: '#scan-detail' },
        undefined,
        { shallow: true },
      );
    });

    it('drops the fragment when the user moves to a tab that cannot show it', () => {
      window.location.hash = '#scan-detail';
      const { result } = renderHook(() => useUrlTab('view', TABS, 'overview', {
        hashTabs: { 'scan-detail': 'scans' },
      }));
      act(() => result.current[1]('rules'));
      expect(replace).toHaveBeenCalledWith(
        { query: { view: 'rules' }, hash: '' },
        undefined,
        { shallow: true },
      );
    });

    it('scrolls to the section once the tab has rendered it', async () => {
      window.location.hash = '#late-section';
      const scrollIntoView = jest.fn();
      const focus = jest.fn();
      renderHook(() => useUrlTab('view', TABS, 'overview'));

      // The element only appears after the tab mounts — which is AFTER the
      // browser's own fragment scroll has already fired and found nothing.
      const el = document.createElement('div');
      el.id = 'late-section';
      el.scrollIntoView = scrollIntoView;
      el.focus = focus;
      document.body.appendChild(el);

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      el.remove();
    });
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

describe('formatDuration — one duration vocabulary', () => {
  /**
   * There were three: `fmtMs` rendered milliseconds as "2.1m", `formatDuration`
   * on the pipeline detail page rendered the SAME input as "2m 5s", and
   * `fmtSeconds` covered hours/days but only from seconds. One build's elapsed
   * time therefore read differently depending on which page showed it.
   */
  it('covers the full range from milliseconds to days', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(300_000)).toBe('5m');      // exact minutes, no trailing 0s
    expect(formatDuration(3_720_000)).toBe('1h 2m');
    expect(formatDuration(86_400_000)).toBe('1d');   // exact day, no trailing hours
    expect(formatDuration(90_000_000)).toBe('1d 1h');
  });

  it('renders the placeholder for null/negative rather than "NaN" or "-1ms"', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(null, 'n/a')).toBe('n/a');
  });

  it('formatDurationSeconds is the same vocabulary, keyed on seconds', () => {
    // The DORA MTTR / lead-time surfaces report seconds; they must not drift
    // into a second rendering of the same elapsed time.
    expect(formatDurationSeconds(45)).toBe(formatDuration(45_000));
    expect(formatDurationSeconds(3_720)).toBe(formatDuration(3_720_000));
    expect(formatDurationSeconds(null)).toBe('—');
  });
});
