// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugins catalog: category and step type are always-visible quick filters
 * (not buried in Advanced, and not counted as "advanced"), and a filtered-empty
 * list reads differently from a first-run empty one.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ entitled: false, isLoaded: true, label: 'x', description: '', unlocks: '', upsellHref: '/', reason: 'not on plan' }),
}));
jest.mock('@/lib/favorites', () => ({ useFavorites: () => ({ favorites: new Set<string>(), toggle: jest.fn<AnyFn>() }) }));

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/plugins', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => mockRouter }));

const listPlugins = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listPlugins: (...a: unknown[]) => listPlugins(...a),
    getPluginUsage: () => Promise.resolve({ success: true, data: { counts: {} } }),
  },
}));

import PluginsPage from '../pages/dashboard/plugins';

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.query = {};
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' });
  listPlugins.mockResolvedValue({ success: true, data: { plugins: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } } });
});

it('shows category and step type without opening Advanced', async () => {
  render(<PluginsPage />);
  expect(screen.getByLabelText('Filter by category')).toBeInTheDocument();
  expect(screen.getByLabelText('Filter by type')).toBeInTheDocument();
  // The rest stay under Filters.
  expect(screen.queryByLabelText('Filter by compute')).not.toBeInTheDocument();
  await waitFor(() => expect(listPlugins).toHaveBeenCalled());
});

it('first run and filtered-empty are distinct, and a quick filter is not counted as advanced', async () => {
  render(<PluginsPage />);
  expect(await screen.findByText('No plugins yet')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Filter by category'), { target: { value: 'security' } });
  expect(await screen.findByText('No plugins match your filters')).toBeInTheDocument();
  // The Filters toggle carries no count badge for a quick filter.
  expect(screen.getByRole('button', { name: /^filters$/i })).toBeInTheDocument();

  fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
  expect(await screen.findByText('No plugins yet')).toBeInTheDocument();
  expect(screen.getByLabelText('Filter by category')).toHaveValue('all');
});
