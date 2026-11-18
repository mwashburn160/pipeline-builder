// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The offers console states nothing about its counts until they are read:
 * "No decisions recorded yet" and "0 in the measurement holdout" are claims,
 * and while the first read is in flight — or after it failed — they are false.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/billing/BillingAdminTabs', () => ({ __esModule: true, BillingAdminTabs: () => null }));

const listAdminOffers = jest.fn<AnyFn>();
const listOfferExclusions = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listAdminOffers: (...a: unknown[]) => listAdminOffers(...a),
    listOfferExclusions: (...a: unknown[]) => listOfferExclusions(...a),
  },
}));

import AdminOffersPage from '../pages/dashboard/admin/offers';

const arm = { accounts: 0, sent: 0, conversions: 0, conversionRate: 0 };
const SUMMARY = {
  offers: [], total: 0, limit: 50, offset: 0,
  counts: { byStatus: {}, bySuppressionReason: {}, holdout: 0 },
  enabled: { billing: true, offers: true },
  lift: { offered: arm, holdout: arm, lift: 0, skuMatch: {}, timeToConversion: {} },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ user: { id: 'u1', organizationId: 'system' }, can: () => true });
  listOfferExclusions.mockResolvedValue({ success: true, data: { exclusions: [] } });
});

describe('admin offers — first read', () => {
  it('says it is loading, not "No decisions recorded yet", while the read is in flight', async () => {
    listAdminOffers.mockImplementation(() => new Promise(() => {}));
    render(<AdminOffersPage />);
    expect(await screen.findByText(/Loading offer decisions/)).toBeInTheDocument();
    expect(screen.queryByText('No decisions recorded yet.')).not.toBeInTheDocument();
    expect(screen.queryByText(/in the measurement holdout/)).not.toBeInTheDocument();
  });

  it('a failed read shows the error, and no counts', async () => {
    listAdminOffers.mockRejectedValue(new Error('billing down'));
    render(<AdminOffersPage />);
    expect(await screen.findByText(/billing down/)).toBeInTheDocument();
    expect(screen.queryByText('No decisions recorded yet.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading offer decisions/)).not.toBeInTheDocument();
  });

  it('an empty answer reads as empty once it arrives', async () => {
    listAdminOffers.mockResolvedValue({ success: true, data: SUMMARY });
    render(<AdminOffersPage />);
    expect(await screen.findByText('No decisions recorded yet.')).toBeInTheDocument();
  });
});

describe('admin offers — do-not-offer list', () => {
  it('says when the paged exclusion list holds more than the page shown', async () => {
    // The server pages the veto list (newest 200 by default); without `total`
    // the older vetoes silently vanished from a list that looked complete.
    listAdminOffers.mockResolvedValue({ success: true, data: SUMMARY });
    listOfferExclusions.mockResolvedValue({
      success: true,
      data: { exclusions: [{ orgId: 'org-a', reason: 'negotiation', actorId: 'u1', createdAt: '2026-11-01T00:00:00.000Z' }], total: 3, limit: 1, offset: 0 },
    });
    render(<AdminOffersPage />);
    expect(await screen.findByTestId('exclusions-truncated')).toHaveTextContent('Showing the newest 1 of 3 excluded accounts.');
  });

  it('says nothing extra when the whole list is on screen', async () => {
    listAdminOffers.mockResolvedValue({ success: true, data: SUMMARY });
    listOfferExclusions.mockResolvedValue({
      success: true,
      data: { exclusions: [{ orgId: 'org-a', reason: 'negotiation', actorId: 'u1', createdAt: '2026-11-01T00:00:00.000Z' }], total: 1, limit: 200, offset: 0 },
    });
    render(<AdminOffersPage />);
    expect(await screen.findByText('org-a')).toBeInTheDocument();
    expect(screen.queryByTestId('exclusions-truncated')).not.toBeInTheDocument();
  });
});
