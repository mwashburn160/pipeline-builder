// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Organizations console: the client-side facets (KMS, SSO, deletion state,
 * scope) narrow the loaded page and say so, and each select writes its filter.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/admin/StepUpModal', () => ({ __esModule: true, StepUpModal: () => null }));
jest.mock('@/components/RecentlyDeletedPanel', () => ({ __esModule: true, RecentlyDeletedPanel: () => null }));
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query: {}, pathname: '/dashboard/organizations', replace: jest.fn(), push: jest.fn() })));

const orgs = [
  { id: 'o-kms', name: 'Kms Co', slug: 'kms', tier: 'pro', kmsConfigured: true, idpConfigured: false },
  { id: 'o-idp', name: 'Idp Co', slug: 'idp', tier: 'team', kmsConfigured: false, idpConfigured: true },
  { id: 'o-team', name: 'Team Co', slug: 'team', tier: 'team', parentOrgId: 'o-idp' },
  { id: 'o-gone', name: 'Gone Co', slug: 'gone', tier: 'developer', pendingDeletion: true, deletedAt: '2026-11-01T00:00:00Z' },
];
let filters: Record<string, string> = {};
const updateFilter = jest.fn<AnyFn>();
jest.mock('@/hooks/useListPage', () => ({
  __esModule: true,
  useListPage: () => ({
    data: orgs, filters, error: null, isLoading: false,
    pagination: { total: orgs.length, offset: 0, limit: 25 },
    refresh: jest.fn(), setError: jest.fn(), updateFilter,
    handlePageChange: jest.fn(), handlePageSizeChange: jest.fn(),
  }),
}));
jest.mock('@/lib/api', () => ({ __esModule: true, default: {} }));

import OrganizationsPage from '../pages/dashboard/organizations';

const shown = () => orgs.map((o) => o.name).filter((n) => screen.queryAllByText(n).length > 0);

beforeEach(() => {
  jest.clearAllMocks();
  filters = { search: '', tier: 'all', deleted: 'hide', kms: 'all', idp: 'all', scope: 'all' };
  mockAuthGuard({ isSuperAdmin: true, user: { id: 'me', organizationId: 'system' }, can: () => true });
});

describe('organizations facets', () => {
  it('hides pending-deletion orgs by default', () => {
    render(<OrganizationsPage />);
    expect(shown()).toEqual(['Kms Co', 'Idp Co', 'Team Co']);
  });

  it.each([
    [{ kms: 'yes' }, ['Kms Co']],
    [{ kms: 'no' }, ['Idp Co', 'Team Co']],
    [{ idp: 'yes' }, ['Idp Co']],
    [{ idp: 'no' }, ['Kms Co', 'Team Co']],
    [{ scope: 'team' }, ['Team Co']],
    [{ scope: 'top' }, ['Kms Co', 'Idp Co']],
    [{ deleted: 'only' }, ['Gone Co']],
    [{ deleted: 'show' }, ['Kms Co', 'Idp Co', 'Team Co', 'Gone Co']],
  ])('%o narrows the page', (facet, expected) => {
    filters = { ...filters, ...facet };
    render(<OrganizationsPage />);
    expect(shown()).toEqual(expected);
  });

  it('each select writes its filter', () => {
    render(<OrganizationsPage />);
    fireEvent.change(screen.getByLabelText('Filter by per-org KMS'), { target: { value: 'yes' } });
    fireEvent.change(screen.getByLabelText('Filter by SSO / IdP'), { target: { value: 'no' } });
    fireEvent.change(screen.getByLabelText('Filter by deletion state'), { target: { value: 'only' } });
    fireEvent.change(screen.getByLabelText('Filter by tier'), { target: { value: 'pro' } });
    expect(updateFilter.mock.calls).toEqual([['kms', 'yes'], ['idp', 'no'], ['deleted', 'only'], ['tier', 'pro']]);
  });
});
