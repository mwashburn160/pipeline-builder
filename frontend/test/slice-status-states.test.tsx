// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Status states that must not be colour- or toast-only:
 *  - the quota sidebar's health dot carries its verdict as text;
 *  - the registry renders AccessDenied (not toast + redirect) on a 403;
 *  - the build triage's empty state is an EmptyState, not an emoji alert.
 */

import { render, screen } from '@testing-library/react';
import { OrgListItem } from '../src/components/quotas/OrgListItem';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/usePolling', () => ({ __esModule: true, usePolling: () => {} }));

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/registry', isReady: true, replace: jest.fn(), push: jest.fn() };
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => mockRouter }));

// Registry data hooks — the list read is what 403s.
const repoListState: { error: unknown } = { error: null };
jest.mock('@/hooks/useRepositoryList', () => ({
  __esModule: true,
  useRepositoryList: () => ({ groups: [], repos: [], hasMore: false, loading: false, error: repoListState.error, loadMore: jest.fn(), refresh: jest.fn() }),
}));
jest.mock('@/hooks/useImageTags', () => ({
  __esModule: true,
  useImageTags: () => ({ tags: null, loading: false, error: null, refresh: jest.fn() }),
  invalidateImageTags: jest.fn(),
}));
jest.mock('@/hooks/useImageDetail', () => ({ __esModule: true, useImageDetail: () => ({ kind: null, loading: false, error: null }) }));
jest.mock('@/hooks/useTagsWithMetadata', () => ({ __esModule: true, useTagsWithMetadata: () => ({ metadata: {}, loading: false }) }));

const getQueueTriage = jest.fn();
jest.mock('@/lib/api', () => {
  class ApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) { super(message); this.statusCode = statusCode; }
  }
  const api = {
    listImages: () => Promise.resolve({ success: true, data: {} }),
    getQueueTriage: (...a: unknown[]) => getQueueTriage(...a),
  };
  return { __esModule: true, default: api, api, ApiError };
});

describe('OrgListItem health dot', () => {
  it.each([
    ['bg-red-500', 'Quota critical'],
    ['bg-yellow-500', 'Approaching a quota limit'],
    ['bg-green-500', 'Quotas healthy'],
    [undefined, 'Quota health not loaded yet'],
  ])('%s → "%s" as text', (color, label) => {
    render(<OrgListItem org={{ id: 'o1', name: 'Acme' }} selected={false} healthColor={color} onClick={() => {}} />);
    expect(screen.getByRole('button')).toHaveAccessibleName(`${label}: Acme`);
  });
});

describe('registry mid-session 403', () => {
  it('renders the AccessDenied state instead of redirecting', async () => {
    const { ApiError } = jest.requireMock('@/lib/api') as { ApiError: new (m: string, s: number) => Error };
    repoListState.error = new ApiError('forbidden', 403);
    mockAuthGuard({ isSuperAdmin: true, user: { id: 'op', organizationId: 'system' } });
    const { default: RegistryPage } = await import('../pages/dashboard/registry');

    render(<RegistryPage />);

    expect(screen.getByTestId('access-denied')).toHaveTextContent('system administrator access');
    expect(mockRouter.push).not.toHaveBeenCalled();
    repoListState.error = null;
  });
});

describe('build triage empty state', () => {
  it('is an EmptyState with words, not an emoji success alert', async () => {
    getQueueTriage.mockResolvedValue({ success: true, data: { totalFailed: 0, groups: [] } });
    mockAuthGuard({ isSuperAdmin: true, user: { id: 'op', organizationId: 'system' } });
    const { default: TriagePage } = await import('../pages/dashboard/triage');

    render(<TriagePage />);

    expect(await screen.findByText('No failed builds')).toBeInTheDocument();
    expect(screen.queryByText(/✅/)).not.toBeInTheDocument();
  });
});
