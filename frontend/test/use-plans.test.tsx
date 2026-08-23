// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from '@testing-library/react';
import { usePlans } from '../src/hooks/usePlans';

const getPlans = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getPlans: (...a: unknown[]) => getPlans(...a) },
}));

describe('usePlans', () => {
  beforeEach(() => jest.clearAllMocks());

  it('short-circuits when disabled — no fetch, not loading', () => {
    const { result } = renderHook(() => usePlans(false));
    expect(getPlans).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.plans).toEqual([]);
  });

  it('fetches plans when enabled', async () => {
    getPlans.mockResolvedValue({ success: true, data: { plans: [{ id: 'pro', name: 'Pro' }] } });
    const { result } = renderHook(() => usePlans(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getPlans).toHaveBeenCalledTimes(1);
    expect(result.current.plans).toHaveLength(1);
  });

  it('is fail-soft — stays empty when the fetch rejects', async () => {
    getPlans.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => usePlans(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.plans).toEqual([]);
  });
});
