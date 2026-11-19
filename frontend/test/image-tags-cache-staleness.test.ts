// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `useImageTags` keeps a module-level cache keyed by repo name only, which is
 * why `clearImageTagsCache` runs at every identity boundary (org switch,
 * sign-out, impersonation) and `invalidateImageTags` after a copy. A listing
 * still on the wire when either runs answers for the identity / the tag set
 * that WAS — it must not be written back into the cache, or the next mount
 * serves it as a fresh hit.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook, act, waitFor } from '@testing-library/react';

const listImageTags = jest.fn<AnyFn>();
jest.mock('../src/lib/api', () => {
  const api = { listImageTags: (...a: unknown[]) => listImageTags(...a) };
  return { __esModule: true, default: api, api };
});

import { useImageTags, clearImageTagsCache, invalidateImageTags } from '../src/hooks/useImageTags';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('useImageTags cache boundaries', () => {
  beforeEach(() => { clearImageTagsCache(); listImageTags.mockReset(); });

  it('does not cache a listing that was in flight when the cache was cleared', async () => {
    const stale = deferred<unknown>();
    listImageTags.mockReturnValueOnce(stale.promise);
    const first = renderHook(() => useImageTags('app'));
    expect(listImageTags).toHaveBeenCalledTimes(1);

    // Identity boundary while the old org's listing is still out.
    clearImageTagsCache();
    await act(async () => { stale.resolve({ data: { tags: ['org-a-secret'] } }); });
    first.unmount();

    listImageTags.mockResolvedValueOnce({ data: { tags: ['org-b'] } });
    const second = renderHook(() => useImageTags('app'));
    await waitFor(() => expect(second.result.current.tags).toEqual(['org-b']));
    expect(listImageTags).toHaveBeenCalledTimes(2);
  });

  it('does not cache a listing that was in flight when the repo was invalidated', async () => {
    const stale = deferred<unknown>();
    listImageTags.mockReturnValueOnce(stale.promise);
    const first = renderHook(() => useImageTags('app'));

    invalidateImageTags('app');
    await act(async () => { stale.resolve({ data: { tags: ['before-copy'] } }); });
    first.unmount();

    listImageTags.mockResolvedValueOnce({ data: { tags: ['before-copy', 'copied'] } });
    const second = renderHook(() => useImageTags('app'));
    await waitFor(() => expect(second.result.current.tags).toEqual(['before-copy', 'copied']));
  });

  it('keeps the newer of two overlapping listings', async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    listImageTags.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useImageTags('app'));
    act(() => result.current.refresh());

    await act(async () => { newer.resolve({ data: { tags: ['v2'] } }); });
    await act(async () => { older.resolve({ data: { tags: ['v1'] } }); });
    expect(result.current.tags).toEqual(['v2']);
    expect(result.current.loading).toBe(false);
  });
});
