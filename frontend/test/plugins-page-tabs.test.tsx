// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugins dashboard: My plugins / Catalog / Installs / Security / Builds tabs
 * (Security holding Vulnerability search, Remediations, Policy and Approvals),
 * Approvals only for `plugin_installs:manage`, Builds only for `plugins:write`,
 * `?tab=` / `?section=` deep links, and the shadowing flag on an
 * own plugin whose name shadows an Official listing.
 */
import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  // PluginDetailModal shows whether a vulnerability waiver covers the plugin,
  // so mounting the page reaches for the waiver list. The module mock is a
  // Proxy over this object, so an absent key is `undefined` and the call throws
  // inside the fetch — which surfaces as this suite timing out, not as a clear
  // error. Resolved empty: these tests are about the tab/shadowing behaviour.
  listVulnWaivers: jest.fn<AnyFn>(),
  getPluginUsage: jest.fn<AnyFn>(),
  getPluginShadowing: jest.fn<AnyFn>(),
  getPluginCatalog: jest.fn<AnyFn>(),
  getInstallPolicy: jest.fn<AnyFn>(),
  listPluginInstalls: jest.fn<AnyFn>(),
  getQueueFailed: jest.fn<AnyFn>(),
  getQueueDlq: jest.fn<AnyFn>(),
  listPublisherListings: jest.fn<AnyFn>(),
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
  api.listVulnWaivers.mockReturnValue(ok({ waivers: [] }));
  api.getInstallPolicy.mockReturnValue(ok({ policy: POLICY, effective: POLICY, inheritsFromRoot: false, updatedBy: null, updatedAt: null, canEdit: false }));
  api.listPluginInstalls.mockReturnValue(ok({ installs: [], policy: POLICY }));
  api.getQueueFailed.mockReturnValue(ok({ jobs: [], pagination: { limit: 25, offset: 0, hasMore: false } }));
  api.getQueueDlq.mockReturnValue(ok({ jobs: [], pagination: { limit: 25, offset: 0, hasMore: false } }));
  api.listPublisherListings.mockReturnValue(ok({ listings: [] }));
});

it('flags an own plugin that shadows an Official listing', async () => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' });
  render(<PluginsPage />);
  expect(await screen.findByTestId('shadowing-badge')).toHaveAttribute('title', expect.stringContaining('pipeline-builder/trivy'));
  fireEvent.click(screen.getByRole('button', { name: 'trivy' }));
  expect(await screen.findByTestId('shadowing-notice')).toBeInTheDocument();
});

it('has five tabs, with Security holding four sub-tabs', async () => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => ['plugins:read', 'plugins:write', 'plugin_installs:manage'].includes(p) });
  render(<PluginsPage />);
  const bar = screen.getByRole('tablist', { name: 'Plugin sections' });
  expect(within(bar).getAllByRole('tab').map((t) => t.textContent)).toEqual(['My plugins', 'Catalog', 'Installs', 'Security', 'Builds']);
  expect(screen.queryByRole('tab', { name: 'Policy' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Security' }));
  const subs = within(screen.getByRole('tablist', { name: 'Security sections' })).getAllByRole('tab');
  expect(subs.map((t) => t.textContent)).toEqual(['Vulnerability search', 'Remediations', 'Policy', 'Approvals']);
  expect(mockRouter.replace).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ tab: 'security' }) }), undefined, { shallow: true });
  fireEvent.click(screen.getByRole('tab', { name: 'Policy' }));
  expect(mockRouter.replace).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ tab: 'security', section: 'policy' }) }), undefined, { shallow: true });
  expect(await screen.findByTestId('policy-tab')).toBeInTheDocument();
});

it('shows Approvals only with plugin_installs:manage, and switches tabs through the URL', async () => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' });
  mockRouter.query = { tab: 'security', section: 'policy' };
  const { unmount } = render(<PluginsPage />);
  expect(screen.getByRole('tab', { name: 'Policy' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('tab', { name: 'Approvals' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Catalog' }));
  expect(mockRouter.replace).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ tab: 'catalog' }) }), undefined, { shallow: true });
  unmount();
  api.listPlugins.mockClear();

  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => ['plugins:read', 'plugin_installs:manage'].includes(p) });
  mockRouter.query = { tab: 'security', section: 'policy' };
  render(<PluginsPage />);
  expect(screen.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Policy' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Approvals' })).toBeInTheDocument();
  expect(await screen.findByTestId('policy-tab')).toBeInTheDocument();
  // The own-plugin list isn't fetched while another tab is open.
  await waitFor(() => expect(api.getInstallPolicy).toHaveBeenCalled());
  expect(api.listPlugins).not.toHaveBeenCalled();
});

it('?section=approvals without plugin_installs:manage opens the first Security sub-tab, not Approvals', () => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' });
  mockRouter.query = { tab: 'security', section: 'approvals' };
  render(<PluginsPage />);
  expect(screen.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Vulnerability search' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByTestId('approvals-tab')).toBeNull();
});

it('shows Builds only with plugins:write, and ?tab=builds without it lands on My plugins', async () => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' });
  mockRouter.query = { tab: 'builds' };
  const { unmount } = render(<PluginsPage />);
  expect(screen.queryByRole('tab', { name: 'Builds' })).toBeNull();
  expect(screen.queryByTestId('org-failed-builds')).toBeNull();
  await waitFor(() => expect(api.listPlugins).toHaveBeenCalled());
  expect(api.getQueueFailed).not.toHaveBeenCalled();
  unmount();

  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => ['plugins:read', 'plugins:write'].includes(p) });
  render(<PluginsPage />);
  expect(screen.getByRole('tab', { name: 'Builds' })).toHaveAttribute('aria-selected', 'true');
  expect(await screen.findByTestId('org-failed-builds')).toHaveTextContent("your organization's");
  await waitFor(() => expect(api.getQueueFailed).toHaveBeenCalled());
  expect(api.getQueueDlq).toHaveBeenCalled();
});

/** A public own plugin `acr-push` in two versions; the org's publisher lists 1.0.1 of it. */
function ownPublicPlugins() {
  api.listPlugins.mockReturnValue(ok({
    plugins: [
      { id: 'a1', orgId: 'org-1', name: 'acr-push', version: '1.0.1', visibility: 'public', isActive: true, isDefault: true, createdBy: 'u1' },
      { id: 'a2', orgId: 'org-1', name: 'acr-push', version: '1.0.2', visibility: 'public', isActive: true, isDefault: false, createdBy: 'u1' },
    ],
    pagination: { total: 2, limit: 25, offset: 0, hasMore: false },
  }));
  api.getPluginShadowing.mockReturnValue(ok({ shadowing: [] }));
  api.listPublisherListings.mockReturnValue(ok({ listings: [{
    id: 'L1', publisherHandle: 'pipeline-builder', name: 'acr-push', state: 'listed', pausedAt: null,
    versions: [{ id: 'v1', version: '1.0.1', pausedAt: null, yankedAt: null }],
  }] }));
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' || p === 'plugins:publish' });
}

it('a version already listed offers its public page, not "Publish to ecosystem"', async () => {
  ownPublicPlugins();
  render(<PluginsPage />);
  const rows = await screen.findAllByRole('button', { name: 'acr-push' });
  fireEvent.click(rows[0]);
  expect(await screen.findByRole('link', { name: /View public page/ })).toHaveAttribute('href', '/plugins/pipeline-builder/acr-push');
  expect(screen.queryByRole('link', { name: /Publish to ecosystem/ })).toBeNull();
  expect(api.listPublisherListings).toHaveBeenCalledTimes(1);
});

it('a version not yet listed offers "Publish to ecosystem"', async () => {
  ownPublicPlugins();
  render(<PluginsPage />);
  const rows = await screen.findAllByRole('button', { name: 'acr-push' });
  fireEvent.click(rows[1]);
  expect(await screen.findByRole('link', { name: /Publish to ecosystem/ })).toHaveAttribute('href', '/dashboard/publisher?tab=requests&section=publish&pluginId=a2');
  expect(screen.queryByRole('link', { name: /View public page/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  fireEvent.click(rows[0]);
  await screen.findByRole('link', { name: /View public page/ });
  expect(api.listPublisherListings).toHaveBeenCalledTimes(1);
});
