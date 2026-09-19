// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Billing page stability:
 *  - A profile refresh (tab refocus) with the same user must not reload the
 *    page or drop an open dialog.
 *  - Reloading after a change refreshes in place — the page is not swapped for
 *    a full-screen spinner (which unmounts open dialogs and the tab bar).
 *  - `?highlight=<feature>` with no tab lands on the Add-ons tab.
 */

import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import BillingPage from '../pages/dashboard/billing';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const mockRouter = {
  query: {} as Record<string, string>,
  pathname: '/dashboard/billing',
  isReady: true,
  replace: jest.fn((url: { query: Record<string, string> }) => { mockRouter.query = url.query; return Promise.resolve(true); }),
  push: jest.fn(),
};
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => mockRouter }));
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: () => ({ organizations: [{ id: 'org-1', name: 'Acme' }] }) }));
jest.mock('@/hooks/useBillingEnabled', () => ({
  __esModule: true,
  useBillingEnabledState: () => true,
  useBillingProvider: () => 'stub',
}));

// Heavy children reduced to the controls this test drives.
jest.mock('@/components/billing/PlanGrid', () => ({
  __esModule: true,
  PlanGrid: ({ onSubscribe }: { onSubscribe: (id: string) => void }) => (
    <button type="button" onClick={() => onSubscribe('pro')}>Choose Pro</button>
  ),
}));
jest.mock('@/components/billing/PlanChangeModal', () => ({
  __esModule: true,
  PlanChangeModal: ({ onConfirm }: { onConfirm: () => void }) => (
    <div role="dialog"><button type="button" onClick={onConfirm}>Confirm plan change</button></div>
  ),
}));
jest.mock('@/components/billing/AddonGrid', () => ({
  __esModule: true,
  AddonGrid: ({ highlightFeature }: { highlightFeature: string | null }) => <p>Add-on grid (highlight: {highlightFeature})</p>,
}));
for (const [path, name] of [
  ['@/components/billing/SubscriptionStatusCard', 'SubscriptionStatusCard'],
  ['@/components/billing/UsageCard', 'UsageCard'],
  ['@/components/billing/BillingDashboard', 'BillingDashboard'],
  ['@/components/billing/TeamUsageCard', 'TeamUsageCard'],
  ['@/components/billing/DiscountRedeem', 'DiscountRedeem'],
  ['@/components/billing/BillingHistory', 'BillingHistory'],
  ['@/components/billing/MarketplaceEntitlementsPanel', 'MarketplaceEntitlementsPanel'],
] as const) {
  jest.doMock(path, () => ({ __esModule: true, [name]: () => null }));
}

const getPlans = jest.fn();
const getSubscription = jest.fn();
const changeSubscription = jest.fn();
jest.mock('@/lib/api', () => {
  const overrides: Record<string, unknown> = {
    getPlans: (...a: unknown[]) => getPlans(...a),
    changeSubscription: (...a: unknown[]) => changeSubscription(...a),
    getSubscription: (...a: unknown[]) => getSubscription(...a),
    getBundles: () => Promise.resolve({ success: true, data: { bundles: [{ id: 'b1', name: 'Seat pack' }], selfService: true, comboDiscounts: [] } }),
  };
  const api = new Proxy({}, { get: (_t, k: string) => overrides[k] ?? (() => Promise.resolve({ success: true, data: null })) });
  return { __esModule: true, default: api, api, ApiError: class extends Error {} };
});

const subscription = { success: true, data: { subscription: { id: 'sub-1', planId: 'developer', planName: 'Developer', interval: 'monthly', status: 'active' } } };
const plans = { success: true, data: { plans: [{ id: 'developer', name: 'Developer', prices: { monthly: 0, annual: 0 } }, { id: 'pro', name: 'Pro', prices: { monthly: 10, annual: 100 } }] } };

describe('BillingPage', () => {
  beforeEach(() => {
    mockRouter.query = {};
    getPlans.mockResolvedValue(plans);
    getSubscription.mockResolvedValue(subscription);
    changeSubscription.mockResolvedValue({ success: true });
    mockAuthGuard({ isAdmin: true, user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
  });

  it('keeps an open dialog and does not reload when the profile refreshes unchanged', async () => {
    mockRouter.query = { tab: 'plans' };
    const authGuard = mockAuthGuard({ isAdmin: true, user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
    const { rerender } = render(<BillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose Pro' }));
    expect(screen.getByRole('button', { name: 'Confirm plan change' })).toBeInTheDocument();

    // A refocus refresh hands the page an equal-but-new user object.
    authGuard.user = { id: 'u1', organizationId: 'org-1' };
    rerender(<BillingPage />);
    await act(async () => {});

    expect(getPlans).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Confirm plan change' })).toBeInTheDocument();
  });

  it('reloads in place after a change instead of swapping in a full-page spinner', async () => {
    mockRouter.query = { tab: 'plans' };
    render(<BillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose Pro' }));

    // The SUBSCRIPTION read is the reload probe, not the plan catalog: the
    // catalog is served from the shared query cache (it cannot change under a
    // plan switch), while the subscription is deliberately re-read with
    // `force` because this page is the one that just mutated it.
    let finishReload!: (v: unknown) => void;
    getSubscription.mockReturnValueOnce(new Promise((r) => { finishReload = r; }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm plan change' }));
    await waitFor(() => expect(getSubscription).toHaveBeenCalledTimes(2));

    // Mid-reload: the page (tab bar + plan grid) is still there.
    expect(screen.getByRole('button', { name: 'Choose Pro' })).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();

    await act(async () => { finishReload(subscription); });
    expect(screen.queryByRole('button', { name: 'Confirm plan change' })).not.toBeInTheDocument();
  });

  it('lands a ?highlight= deep-link without a tab on the Add-ons tab', async () => {
    mockRouter.query = { highlight: 'advanced_reporting' };
    render(<BillingPage />);
    expect(await screen.findByText('Add-on grid (highlight: advanced_reporting)')).toBeInTheDocument();
  });
});
