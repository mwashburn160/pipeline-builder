// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The at-risk views, which had two holes the API did not:
 *
 *  - `threshold` is accepted by both at-risk endpoints and forwarded by the
 *    client, but the page hardcoded the server's 80 default — so "who has
 *    ALREADY used a quota up?" (threshold=100) could not be asked.
 *  - the client typed the entry's `type` as four quota kinds while the quota
 *    service scans all nine (`VALID_QUOTA_TYPES`), so `storageBytes` and
 *    `idpConfigs` rendered as their raw keys.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import QuotasPage from '../pages/dashboard/quotas';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ tierPresets: undefined, isEnabled: () => true, isLoaded: true }),
}));
jest.mock('@/lib/api-cache', () => ({
  __esModule: true,
  queries: { listOrganizations: () => null },
  invalidate: {},
}));
jest.mock('@/hooks/useQuery', () => ({ __esModule: true, useQuery: () => ({ data: undefined, error: undefined }) }));

const summary = (limit: number, used: number) => ({ limit, used, remaining: Math.max(0, limit - used), unlimited: false, resetAt: '' });
const QUOTA = {
  orgId: 'org-1',
  name: 'Acme',
  slug: 'acme',
  tier: 'team',
  quotas: {
    plugins: summary(100, 90), pipelines: summary(20, 3), apiCalls: summary(1000, 10), aiCalls: summary(100, 1),
  },
};

const getAtRiskQuotas = jest.fn<AnyFn>();
const getOrgAtRisk = jest.fn<AnyFn>();
const getOrgQuotas = jest.fn<AnyFn>();
const getOwnQuotas = jest.fn<AnyFn>();
const getAllOrgQuotas = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => {
  const api = {
    getAtRiskQuotas: (...a: unknown[]) => getAtRiskQuotas(...a),
    getOrgAtRisk: (...a: unknown[]) => getOrgAtRisk(...a),
    getOrgQuotas: (...a: unknown[]) => getOrgQuotas(...a),
    getOwnQuotas: (...a: unknown[]) => getOwnQuotas(...a),
    getAllOrgQuotas: (...a: unknown[]) => getAllOrgQuotas(...a),
  };
  return { __esModule: true, default: api, api };
});

/** Two dimensions outside the four original quota kinds, which must still be labelled. */
const NEWER_KINDS = [
  { orgId: 'org-9', name: 'Beta Co', slug: 'beta', type: 'storageBytes', used: 95, limit: 100, percent: 95 },
  { orgId: 'org-9', name: 'Beta Co', slug: 'beta', type: 'idpConfigs', used: 3, limit: 3, percent: 100 },
];

beforeEach(() => {
  jest.clearAllMocks();
  getAtRiskQuotas.mockResolvedValue({ success: true, data: { atRisk: NEWER_KINDS } });
  getOrgAtRisk.mockResolvedValue({ success: true, data: { atRisk: NEWER_KINDS } });
  getOrgQuotas.mockResolvedValue({ success: true, data: { quota: QUOTA } });
  getOwnQuotas.mockResolvedValue({ success: true, data: { quota: QUOTA } });
  getAllOrgQuotas.mockResolvedValue({ success: true, data: { organizations: [] } });
});

function asSysadmin() {
  mockAuthGuard({ isSuperAdmin: true, isAdmin: true, user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
}
function asOrgAdmin() {
  mockAuthGuard({ isSuperAdmin: false, isAdmin: true, user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
}

describe('sysadmin at-risk banner', () => {
  it('asks the API with the default cut-off, then with the one the operator picks', async () => {
    asSysadmin();
    render(<QuotasPage />);
    await waitFor(() => expect(getAtRiskQuotas).toHaveBeenCalledWith(80));

    fireEvent.change(await screen.findByLabelText('At-risk threshold'), { target: { value: '100' } });
    await waitFor(() => expect(getAtRiskQuotas).toHaveBeenCalledWith(100));
    // The heading says what was asked, not a hardcoded "≥80%".
    expect(await screen.findByText(/already exhausted on a quota/i)).toBeInTheDocument();
  });

  it('labels every quota kind the scan can return, not just the original four', async () => {
    asSysadmin();
    render(<QuotasPage />);
    expect(await screen.findByText(/Storage 95%/)).toBeInTheDocument();
    expect(screen.getByText(/IdP configs 100%/)).toBeInTheDocument();
    // The raw keys must not leak through.
    expect(screen.queryByText(/storageBytes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/idpConfigs/)).not.toBeInTheDocument();
  });

  it('answers "nobody" rather than vanishing when nothing matches', async () => {
    asSysadmin();
    getAtRiskQuotas.mockResolvedValue({ success: true, data: { atRisk: [] } });
    render(<QuotasPage />);
    expect(await screen.findByText(/No organization is at 80% or more on any quota/i)).toBeInTheDocument();
  });
});

describe('an org admin\'s own at-risk callout', () => {
  it('forwards the same cut-off to the tenancy-scoped endpoint and labels every kind', async () => {
    asOrgAdmin();
    render(<QuotasPage />);
    await waitFor(() => expect(getOrgAtRisk).toHaveBeenCalledWith('org-1', 80));
    expect(await screen.findByText('Storage')).toBeInTheDocument();
    expect(screen.getByText('IdP configs')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('At-risk threshold'), { target: { value: '100' } });
    await waitFor(() => expect(getOrgAtRisk).toHaveBeenCalledWith('org-1', 100));
    expect(await screen.findByText(/Limits you have used up/i)).toBeInTheDocument();
  });
});
