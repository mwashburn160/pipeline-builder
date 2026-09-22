// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Billing-admin detail views + promotion revoke:
 *  - `?id=` on the Discounts / Promotions pages opens a detail drawer that reads
 *    the record through GET /billing/admin/{discounts,promotions}/:id.
 *  - A row's Details action writes `?id=` (deep-linkable); closing drops it.
 *  - Revoking a promotion goes through DELETE (audited as
 *    `billing.promotion.revoke`), not a PUT isActive flip.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import DiscountsPage from '../pages/dashboard/discounts';
import PromotionsPage from '../pages/dashboard/promotions';
import BillingAdminPage from '../pages/dashboard/admin/billing';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/billing/BillingAdminTabs', () => ({ __esModule: true, BillingAdminTabs: () => null }));

const mockRouter = {
  query: {} as Record<string, string>,
  pathname: '/dashboard/discounts',
  isReady: true,
  replace: jest.fn<AnyFn>((url: { query: Record<string, string> }) => { mockRouter.query = url.query; return Promise.resolve(true); }),
  push: jest.fn<AnyFn>(),
};
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => mockRouter }));

const listPage = {
  data: [] as unknown[],
  filters: { active: 'all' } as Record<string, string>,
  error: null,
  isLoading: false,
  pagination: { total: 1, offset: 0, limit: 25 },
  refresh: jest.fn<AnyFn>(),
  setError: jest.fn<AnyFn>(),
  updateFilter: jest.fn<AnyFn>(),
  handlePageChange: jest.fn<AnyFn>(),
  handlePageSizeChange: jest.fn<AnyFn>(),
};
jest.mock('@/hooks/useListPage', () => ({ __esModule: true, useListPage: () => listPage }));

const apiMock = {
  getDiscount: jest.fn<AnyFn>(),
  getPromotion: jest.fn<AnyFn>(),
  revokePromotion: jest.fn<AnyFn>(),
  updatePromotion: jest.fn<AnyFn>(),
  getPlans: jest.fn<AnyFn>(),
  getAdminBillingSummary: jest.fn<AnyFn>(),
};
jest.mock('@/components/admin/StepUpModal', () => ({ __esModule: true, StepUpModal: () => null }));
jest.mock('@/lib/api', () => ({
  __esModule: true,
  get default() { return apiMock; },
  ApiError: jest.requireActual<typeof import('@/lib/api/errors')>('@/lib/api/errors').ApiError,
}));

const discount = { id: 'd1', value: 2500, unit: 'dollar', kind: 'recurring', campaign: 'spring', timesRedeemed: 3, maxRedemptions: 10, isActive: true };
const promotion = {
  id: 'p1', name: 'Summer credit', value: 5000, unit: 'dollar', kind: 'onetime',
  trigger: { event: 'subscription_created' }, budgetCents: 100000, spentCents: 2000, grantsCount: 4, isActive: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.query = {};
  mockAuthGuard({ isSuperAdmin: true });
  apiMock.getDiscount.mockResolvedValue({ success: true, data: { discount } });
  apiMock.getPromotion.mockResolvedValue({ success: true, data: { promotion } });
  apiMock.getPlans.mockResolvedValue({ success: true, data: { plans: [] } });
  apiMock.revokePromotion.mockResolvedValue({ success: true, data: { promotion: { ...promotion, isActive: false } } });
});

describe('DiscountsPage detail', () => {
  it('opens the detail drawer from a ?id= deep link, reading the record by id', async () => {
    mockRouter.query = { id: 'd1' };
    render(<DiscountsPage />);
    expect(await screen.findByRole('dialog', { name: 'Discount details' })).toBeInTheDocument();
    expect(apiMock.getDiscount).toHaveBeenCalledWith('d1', expect.anything());
    expect(await screen.findByText('3 / 10')).toBeInTheDocument();
    expect(screen.getByText('spring')).toBeInTheDocument();
  });

  it('writes ?id= from the row action and drops it on close', async () => {
    listPage.data = [discount];
    const { rerender } = render(<DiscountsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(mockRouter.query.id).toBe('d1');
    rerender(<DiscountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close details' }));
    expect(mockRouter.query.id).toBeUndefined();
    listPage.data = [];
  });
});

describe('PromotionsPage', () => {
  it('opens the promotion detail drawer from ?id=', async () => {
    mockRouter.query = { id: 'p1' };
    render(<PromotionsPage />);
    expect(await screen.findByRole('dialog', { name: 'Promotion details' })).toBeInTheDocument();
    expect(apiMock.getPromotion).toHaveBeenCalledWith('p1', expect.anything());
    expect(await screen.findByText('$20.00 spent of $1,000.00')).toBeInTheDocument();
  });

  it('revokes through the DELETE route (not a PUT isActive flip)', async () => {
    listPage.data = [promotion];
    render(<PromotionsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).reverse().find((b) => /revoke|delete|confirm/i.test(b.textContent ?? ''))!);
    await waitFor(() => expect(apiMock.revokePromotion).toHaveBeenCalledWith('p1'));
    expect(apiMock.updatePromotion).not.toHaveBeenCalled();
    listPage.data = [];
  });
});

describe('BillingAdminPage finance summary', () => {
  it('shows a retryable error on a failed summary, then re-reads on Retry', async () => {
    apiMock.getAdminBillingSummary.mockRejectedValueOnce(new Error('ledger down'));
    apiMock.getAdminBillingSummary.mockResolvedValue({ success: true, data: { totals: { grossBilledCents: 0, discountsCents: 0, creditsCents: 0, taxCents: 0, netBilledCents: 0, amountPaidCents: 0 }, byOrg: [], invoiceCount: 0 } });
    render(<BillingAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/0 invoices across 0 accounts/)).toBeInTheDocument();
  });

  it('only re-reads the summary for a new range when Apply is pressed', async () => {
    apiMock.getAdminBillingSummary.mockResolvedValue({ success: true, data: null });
    const { container } = render(<BillingAdminPage />);
    await waitFor(() => expect(apiMock.getAdminBillingSummary).toHaveBeenCalledTimes(1));
    const [fromInput] = Array.from(container.querySelectorAll('input[type="date"]'));
    fireEvent.change(fromInput, { target: { value: '2026-01-01' } });
    expect(apiMock.getAdminBillingSummary).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
    await waitFor(() => expect(apiMock.getAdminBillingSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: new Date('2026-01-01').toISOString() }), expect.anything(),
    ));
  });
});
