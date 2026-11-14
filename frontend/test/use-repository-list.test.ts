// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The registry list pages with the SERVER's cursor. The page is filtered
 * server-side (repos the org can't read, empty shells), so a page can hold no
 * names at all while the catalog continues — the cursor must be `next`, never
 * "the last name I was shown".
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook, waitFor } from '@testing-library/react';

const listImages = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  api: { listImages: (...a: unknown[]) => listImages(...a) },
}));

import { useRepositoryList } from '../src/hooks/useRepositoryList';

describe('useRepositoryList', () => {
  it('pages past a page the server filtered to nothing', async () => {
    listImages
      .mockResolvedValueOnce({ success: true, data: { repositories: [], next: 'org-a/zeta' } })
      .mockResolvedValueOnce({ success: true, data: { repositories: ['org-b/app'] } });

    const { result } = renderHook(() => useRepositoryList());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);

    await act(async () => { await result.current.loadMore(); });

    expect(listImages).toHaveBeenLastCalledWith(expect.objectContaining({ last: 'org-a/zeta' }));
    expect(result.current.repos.map((r) => r.name)).toEqual(['org-b/app']);
    expect(result.current.hasMore).toBe(false);
  });
});
