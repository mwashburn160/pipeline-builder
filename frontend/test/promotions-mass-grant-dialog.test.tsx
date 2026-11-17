// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The fleet-wide "Grant to eligible base" dialog:
 *  - Esc / the X cannot close it while the grant is running (the spend is
 *    irreversible and its outcome would otherwise go unseen);
 *  - a grant that finishes after the dialog moved to a DIFFERENT promotion does
 *    not close the new dialog (generation guard).
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import PromotionsPage from '../pages/dashboard/promotions';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/billing/BillingAdminTabs', () => ({ __esModule: true, BillingAdminTabs: () => null }));

const mockRouter = {
  query: {} as Record<string, string>,
  pathname: '/dashboard/promotions',
  isReady: true,
  replace: jest.fn<AnyFn>(() => Promise.resolve(true)),
  push: jest.fn<AnyFn>(),
};
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

const base = {
  id: 'p1', name: 'Summer credit', value: 5000, unit: 'dollar', kind: 'onetime',
  trigger: { event: 'subscription_created' }, budgetCents: 100000, spentCents: 2000, grantsCount: 4, isActive: true,
};
const listPage = {
  data: [base, { ...base, id: 'p2', name: 'Winter credit' }] as unknown[],
  filters: { active: 'all' } as Record<string, string>,
  error: null,
  isLoading: false,
  pagination: { total: 2, offset: 0, limit: 25 },
  refresh: jest.fn<AnyFn>(),
  setError: jest.fn<AnyFn>(),
  updateFilter: jest.fn<AnyFn>(),
  handlePageChange: jest.fn<AnyFn>(),
  handlePageSizeChange: jest.fn<AnyFn>(),
};
jest.mock('@/hooks/useListPage', () => ({ __esModule: true, useListPage: () => listPage }));

const activatePromotion = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    activatePromotion: (...a: unknown[]) => activatePromotion(...a),
    getPlans: () => Promise.resolve({ success: true, data: { plans: [] } }),
  },
}));

let finish: () => void = () => {};
beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ isSuperAdmin: true });
  activatePromotion.mockImplementation(() => new Promise((resolve) => {
    finish = () => resolve({ success: true, data: { result: { granted: 3, matched: 3 } } });
  }));
});

function startGrant(rowIndex: number) {
  fireEvent.click(screen.getAllByRole('button', { name: 'Grant to existing eligible base' })[rowIndex]);
  fireEvent.change(screen.getByPlaceholderText('GRANT'), { target: { value: 'GRANT' } });
  fireEvent.click(screen.getByRole('button', { name: 'Grant credits' }));
}

it('ignores Esc and the X while the grant runs, then closes when it settles', async () => {
  render(<PromotionsPage />);
  startGrant(0);
  await waitFor(() => expect(activatePromotion).toHaveBeenCalledWith('p1'));

  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  expect(screen.getByRole('dialog', { name: 'Grant to eligible base' })).toBeInTheDocument();

  await act(async () => { finish(); });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Grant to eligible base' })).not.toBeInTheDocument());
});

it('a late completion does not close a dialog now showing another promotion', async () => {
  render(<PromotionsPage />);
  startGrant(0);
  await waitFor(() => expect(activatePromotion).toHaveBeenCalledWith('p1'));

  // The dialog is retargeted while the first grant is still in flight.
  fireEvent.click(screen.getAllByRole('button', { name: 'Grant to existing eligible base' })[1]);
  expect(screen.getByText('Winter credit', { selector: 'strong' })).toBeInTheDocument();

  await act(async () => { finish(); });
  expect(screen.getByRole('dialog', { name: 'Grant to eligible base' })).toBeInTheDocument();
  expect(screen.getByText('Winter credit', { selector: 'strong' })).toBeInTheDocument();
});
