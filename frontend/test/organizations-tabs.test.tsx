// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The All Organizations page's two views (the list and the "Deleted items"
 * trash) live in the URL: `?tab=deleted` opens the trash directly, and
 * switching tabs writes the tab back so a refresh or a shared link keeps it.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';
import OrganizationsPage from '../pages/dashboard/organizations';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/admin/StepUpModal', () => ({ __esModule: true, StepUpModal: () => null }));
jest.mock('@/components/RecentlyDeletedPanel', () => ({
  __esModule: true,
  RecentlyDeletedPanel: ({ resource }: { resource: string }) => <div>trash:{resource}</div>,
}));

const replace = jest.fn<AnyFn>();
let query: Record<string, string> = {};
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query, pathname: '/dashboard/organizations', replace, push: jest.fn<AnyFn>() }),
}));

jest.mock('@/hooks/useListPage', () => ({
  __esModule: true,
  useListPage: () => ({
    data: [], filters: {}, error: null, isLoading: false,
    pagination: { total: 0, offset: 0, limit: 25 },
    refresh: jest.fn<AnyFn>(), setError: jest.fn<AnyFn>(), updateFilter: jest.fn<AnyFn>(),
    handlePageChange: jest.fn<AnyFn>(), handlePageSizeChange: jest.fn<AnyFn>(),
  }),
}));
jest.mock('@/lib/api', () => ({ __esModule: true, default: {} }));

beforeEach(() => {
  jest.clearAllMocks();
  query = {};
  mockAuthGuard({ isSuperAdmin: true, user: { id: 'me', organizationId: 'system' }, can: () => true });
});

describe('OrganizationsPage tabs', () => {
  it('opens on the organization list', () => {
    render(<OrganizationsPage />);
    expect(screen.queryByText(/^trash:/)).not.toBeInTheDocument();
  });

  it('opens the trash straight from ?tab=deleted', () => {
    query = { tab: 'deleted' };
    render(<OrganizationsPage />);
    expect(screen.getByText('trash:pipeline')).toBeInTheDocument();
  });

  it('writes the chosen tab to the URL', () => {
    render(<OrganizationsPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Deleted items' }));
    expect(screen.getByText('trash:pipeline')).toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ tab: 'deleted' }) }), undefined, { shallow: true },
    );
  });
});
