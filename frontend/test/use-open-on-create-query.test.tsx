// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `?create=1` must wait until the page can decide. Consumed the moment the
 * router is ready — on a full page load, before the user profile (and its
 * permissions) has loaded — `open` would see no write access, do nothing, and
 * the param would be stripped anyway: the bookmarked / Quick Actions
 * URL never opened the create modal.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook } from '@testing-library/react';
import { useOpenOnCreateQuery } from '../src/hooks/useOpenOnCreateQuery';

const replace = jest.fn<AnyFn>();
const router = { isReady: true, pathname: '/dashboard/pipelines', query: { create: '1' } as Record<string, string>, replace };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => router));

beforeEach(() => { replace.mockClear(); router.query = { create: '1' }; });

describe('useOpenOnCreateQuery', () => {
  it('neither opens nor strips the param while not ready', () => {
    const open = jest.fn<AnyFn>();
    renderHook(() => useOpenOnCreateQuery(open, false));
    expect(open).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('opens once it becomes ready, then strips the param', () => {
    const open = jest.fn<AnyFn>();
    const { rerender } = renderHook(({ ready }) => useOpenOnCreateQuery(open, ready), { initialProps: { ready: false } });
    rerender({ ready: true });
    expect(open).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0].query).not.toHaveProperty('create');
  });
});
