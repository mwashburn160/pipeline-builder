// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `useUrlTab` edge cases the address bar can hand it:
 *  - a fragment that is not valid percent-encoding (`#%zz`, a truncated paste)
 *    must not throw out of the hook's effects and take the page down;
 *  - the URL dropping the tab param while the page stays mounted (a nav link to
 *    the bare page, Back onto it) must put the view back on the fallback, so
 *    what is shown matches what a refresh of that URL would show.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook, act } from '@testing-library/react';
import { useUrlTab } from '../src/hooks/useUrlTab';

const replace = jest.fn<AnyFn>();
let query: Record<string, string> = {};

jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query, pathname: '/dashboard/compliance', replace })));

const TABS = ['overview', 'rules', 'scans'] as const;

describe('useUrlTab edge cases', () => {
  beforeEach(() => { query = {}; replace.mockClear(); });
  afterEach(() => { window.location.hash = ''; });

  it('survives a malformed fragment instead of throwing', () => {
    window.location.hash = '#%zz';
    const { result } = renderHook(() => useUrlTab('view', TABS, 'overview', { hashTabs: { x: 'scans' } }));
    expect(result.current[0]).toBe('overview');
    expect(() => act(() => result.current[1]('rules'))).not.toThrow();
    expect(replace).toHaveBeenCalledWith({ query: { view: 'rules' }, hash: '' }, undefined, { shallow: true });
  });

  it('returns to the fallback when the URL stops naming a tab', () => {
    query = { view: 'scans' };
    const { result, rerender } = renderHook(() => useUrlTab('view', TABS, 'overview'));
    expect(result.current[0]).toBe('scans');

    query = {};
    rerender();
    expect(result.current[0]).toBe('overview');
  });

  it('still opens the fragment owner (not the fallback) when the tab param goes away', () => {
    query = { view: 'rules' };
    const { result, rerender } = renderHook(() => useUrlTab('view', TABS, 'overview', { hashTabs: { 'scan-detail': 'scans' } }));
    expect(result.current[0]).toBe('rules');

    window.location.hash = '#scan-detail';
    query = {};
    rerender();
    expect(result.current[0]).toBe('scans');
  });
});
