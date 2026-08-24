// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * useBillingProvider surfaces the deployment's payment provider (stripe |
 * aws-marketplace | stub) from the `/api/billing/config` probe, so the billing UI
 * picks the right subscribe flow. It's `undefined` until the probe resolves, then
 * the memoised value. The provider is cached at module scope from the same probe
 * `useBillingEnabled` uses (fetched once per session), so this asserts the full
 * unknown → typed-provider transition in a single render.
 */

import { renderHook, waitFor } from '@testing-library/react';

const configResponse: { data?: { enabled?: boolean; provider?: string } } = {
  data: { enabled: true, provider: 'stripe' },
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  api: { getBillingConfig: () => Promise.resolve(configResponse) },
  default: { getBillingConfig: () => Promise.resolve(configResponse) },
}));

import { useBillingProvider } from '../src/hooks/useBillingEnabled';

describe('useBillingProvider', () => {
  it('is undefined until the probe resolves, then returns the typed provider from /config', async () => {
    const { result } = renderHook(() => useBillingProvider());
    // Before the /config probe resolves, the provider is unknown (never coerced).
    expect(result.current).toBeUndefined();
    // Once the probe answers, the hook exposes the deployment's typed provider.
    await waitFor(() => expect(result.current).toBe('stripe'));
  });
});
