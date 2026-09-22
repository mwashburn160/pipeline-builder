// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugins dashboard: My plugins / Catalog / Installs / Approvals / Policy
 * tabs, Approvals only for `plugin_installs:manage`, and the shadowing flag on
 * an own plugin whose name shadows an Official listing.
 */
import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { POLICY } from './helpers/pluginInstallFixtures';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ entitled: false, isLoaded: true, label: 'x', description: '', unlocks: '', upsellHref: '/', reason: 'not on plan' }),
}));
jest.mock('@/lib/favorites', () => ({ useFavorites: () => ({ favorites: new Set<string>(), toggle: jest.fn<AnyFn>() }) }));

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/plugins', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });
const api = {
  listPlugins: jest.fn<AnyFn>(),
  getPluginUsage: jest.fn<AnyFn>(),
  getPluginShadowing: jest.fn<AnyFn>(),
  getPluginCatalog: jest.fn<AnyFn>(),
  getInstallPolicy: jest.fn<AnyFn>(),
  listPluginInstalls: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }) }));

import PluginsPage from '../pages/dashboard/plugins';

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.query = {};
  api.listPlugins.mockReturnValue(ok({
    plugins: [{ id: 'p1', orgId: 'org-1', name: 'trivy', version: '1.0.0', visibility: 'org', isActive: true, isDefault: true, createdBy: 'u1' }],
    pagination: { total: 1, limit: 25, offset: 0, hasMore: false },
  }));
  api.getPluginUsage.mockReturnValue(ok({ counts: { trivy: 3 } }));
  api.getPluginShadowing.mockReturnValue(ok({ shadowing: [{ name: 'trivy', pluginIds: ['p1'], listing: { publisherHandle: 'pipeline-builder', name: 'trivy', publisherTier: 'official' } }] }));
  api.getPluginCatalog.mockReturnValue(ok({ listings: [] }));
  api.getInstallPolicy.mockReturnValue(ok({ policy: POLICY, effective: POLICY, inheritsFromRoot: false, updatedBy: null, updatedAt: null, canEdit: false }));
  api.listPluginInstalls.mockReturnValue(ok({ installs: [], policy: POLICY }));
});

it('flags an own plugin that shadows an Official listing', async () => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' });
  render(<PluginsPage />);
  expect(await screen.findByTestId('shadowing-badge')).toHaveAttribute('title', expect.stringContaining('pipeline-builder/trivy'));
  fireEvent.click(screen.getByRole('button', { name: 'trivy' }));
  expect(await screen.findByTestId('shadowing-notice')).toBeInTheDocument();
});

it('shows Approvals only with plugin_installs:manage, and switches tabs through the URL', async () => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' });
  const { unmount } = render(<PluginsPage />);
  expect(screen.getByRole('tab', { name: 'Catalog' })).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: 'Approvals' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Catalog' }));
  expect(mockRouter.replace).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ tab: 'catalog' }) }), undefined, { shallow: true });
  unmount();
  api.listPlugins.mockClear();

  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => ['plugins:read', 'plugin_installs:manage'].includes(p) });
  mockRouter.query = { tab: 'policy' };
  render(<PluginsPage />);
  expect(screen.getByRole('tab', { name: 'Approvals' })).toBeInTheDocument();
  expect(await screen.findByTestId('policy-tab')).toBeInTheDocument();
  // The own-plugin list isn't fetched while another tab is open.
  await waitFor(() => expect(api.getInstallPolicy).toHaveBeenCalled());
  expect(api.listPlugins).not.toHaveBeenCalled();
});
