// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `useOwnQuota` fails OPEN: a quota read that fails shows nothing and blocks
 * nothing — including when an earlier read had found the quota used up.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook, waitFor } from '@testing-library/react';

const mockApi = { getOwnQuotas: jest.fn<AnyFn>() };
jest.mock('@/lib/api', () => ({ __esModule: true, default: mockApi, api: mockApi }));

import { useOwnQuota } from '../src/hooks/useOwnQuota';

describe('useOwnQuota', () => {
  it('drops an exhausted reading when the re-read fails', async () => {
    mockApi.getOwnQuotas.mockResolvedValueOnce({
      data: { quota: { tier: 'pro', quotas: { aiCalls: { used: 10, limit: 10, remaining: 0 } } } },
    });
    const { result } = renderHook(() => useOwnQuota('aiCalls' as never));
    await waitFor(() => expect(result.current.quota?.summary).toEqual({ used: 10, limit: 10, remaining: 0 }));

    mockApi.getOwnQuotas.mockRejectedValueOnce(new Error('quota service down'));
    await act(async () => { result.current.refresh(); });

    await waitFor(() => expect(result.current.quota).toBeNull());
  });
});
