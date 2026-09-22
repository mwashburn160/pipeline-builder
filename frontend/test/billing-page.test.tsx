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

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
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
  replace: jest.fn<AnyFn>((url: { query: Record<string, string> }) => { mockRouter.query = url.query; return Promise.resolve(true); }),
  push: jest.fn<AnyFn>(),
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
jest.mock('@/components/billing/SubscriptionStatusCard', () => ({
  __esModule: true,
  SubscriptionStatusCard: ({ onCancel }: { onCancel: () => void }) => (
    <button type="button" onClick={onCancel}>Cancel Subscription</button>
  ),
}));
for (const [path, name] of [
  ['@/components/billing/UsageCard', 'UsageCard'],
  ['@/components/billing/BillingDashboard', 'BillingDashboard'],
  ['@/components/billing/TeamUsageCard', 'TeamUsageCard'],
  ['@/components/billing/DiscountRedeem', 'DiscountRedeem'],
  ['@/components/billing/BillingHistory', 'BillingHistory'],
  ['@/components/billing/MarketplaceEntitlementsPanel', 'MarketplaceEntitlementsPanel'],
] as const) {
  jest.doMock(path, () => ({ __esModule: true, [name]: () => null }));
}

// The step-up dialog IS the cancel confirmation: render its details, and a
// confirm that hands over a token.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ details, onConfirmed, onClose }: { details: React.ReactNode; onConfirmed: (t: string) => void; onClose: () => void }) => (
    <div>
      {details}
      <button onClick={onClose}>Keep subscription</button>
      <button onClick={() => onConfirmed('step-up-token')}>Cancel subscription</button>
    </div>
  ),
}));

const getPlans = jest.fn<AnyFn>();
const getSubscription = jest.fn<AnyFn>();
const changeSubscription = jest.fn<AnyFn>();
const cancelSubscription = jest.fn<AnyFn>();
const getBillingUsage = jest.fn<AnyFn>();
const getBundles = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => {
  const overrides: Record<string, unknown> = {
    getPlans: (...a: unknown[]) => getPlans(...a),
    cancelSubscription: (...a: unknown[]) => cancelSubscription(...a),
    getBillingUsage: (...a: unknown[]) => getBillingUsage(...a),
    changeSubscription: (...a: unknown[]) => changeSubscription(...a),
    getSubscription: (...a: unknown[]) => getSubscription(...a),
    getBundles: (...a: unknown[]) => getBundles(...a),
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
    cancelSubscription.mockResolvedValue({ success: true });
    getBillingUsage.mockResolvedValue({ success: true, data: null });
    getBundles.mockResolvedValue({ success: true, data: { bundles: [{ id: 'b1', name: 'Seat pack' }], selfService: true, comboDiscounts: [] } });
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

  it('asks before cancelling, stating access runs to the period end', async () => {
    render(<BillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Subscription' }));
    expect(cancelSubscription).not.toHaveBeenCalled();
    expect(screen.getByText(/stays active until the end of the current/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep subscription' }));
    expect(cancelSubscription).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Subscription' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    await waitFor(() => expect(cancelSubscription).toHaveBeenCalledWith('sub-1', 'step-up-token'));
  });

  it('shows a retryable error when usage fails to load, instead of dropping the section', async () => {
    getBillingUsage.mockRejectedValueOnce(new Error('usage down'));
    render(<BillingPage />);
    expect(await screen.findByText(/couldn't load usage for this period/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(getBillingUsage).toHaveBeenCalledTimes(2));
  });

  it('shows a retryable error when the add-on catalog fails to load', async () => {
    mockRouter.query = { tab: 'addons' };
    getBundles.mockRejectedValueOnce(new Error('bundles down'));
    render(<BillingPage />);
    expect(await screen.findByText(/couldn't load the add-on catalog/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Add-on grid/)).toBeInTheDocument();
  });
});
