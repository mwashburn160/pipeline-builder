// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugins → Remediations: the org's remediations with the stage filter, the
 * daily cap and opted-out pipeline count, a `?remediation=` deep link opening
 * its card, and the operator-off notice.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
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
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });
const api = {
  listPlugins: jest.fn<AnyFn>(),
  listVulnWaivers: jest.fn<AnyFn>(),
  getPluginUsage: jest.fn<AnyFn>(),
  getPluginShadowing: jest.fn<AnyFn>(),
  listPluginRemediations: jest.fn<AnyFn>(),
  getPluginById: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }) }));

import PluginsPage from '../pages/dashboard/plugins';
import { REMEDIATION } from './helpers/remediationFixtures';

const LIST = (over: Record<string, unknown> = {}) => ok({
  remediations: [REMEDIATION, { ...REMEDIATION, id: 'rem-9', pluginName: 'tflint', stage: 'needs_owner', toVersion: null }],
  nextCursor: null, enabled: true, severities: ['critical', 'high'], usedToday: 3, maxPerDay: 20, optedOutPipelines: 4, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.query = { tab: 'security', section: 'remediations' };
  api.listPlugins.mockReturnValue(ok({ plugins: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } }));
  api.getPluginUsage.mockReturnValue(ok({ counts: {} }));
  api.getPluginShadowing.mockReturnValue(ok({ shadowing: [] }));
  api.listVulnWaivers.mockReturnValue(ok({ waivers: [] }));
  api.listPluginRemediations.mockImplementation(() => LIST());
});

describe('Plugins → Remediations', () => {
  it('lists remediations with the daily cap and opted-out pipelines, and filters by stage', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' });
    render(<PluginsPage />);
    expect(await screen.findByTestId('remediation-row-rem-1')).toBeTruthy();
    expect(screen.getByTestId('remediations-usage').textContent).toContain('3 of 20 remediations');
    const optedOut = screen.getByTestId('remediations-opted-out');
    expect(optedOut.textContent).toContain('4 pipelines opted out');
    expect(optedOut.getAttribute('href')).toBe('/dashboard/pipelines?remediationUpgrades=off');
    fireEvent.click(screen.getByRole('button', { name: 'Rolling out' }));
    await waitFor(() => expect(api.listPluginRemediations).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: 'published,rolling_out' }), expect.anything()));
  });

  it('opens the deep-linked remediation, and a viewer without plugins:write gets no Approve', async () => {
    mockRouter.query = { tab: 'security', section: 'remediations', remediation: 'rem-1' };
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' });
    render(<PluginsPage />);
    expect(await screen.findByTestId('remediation-card')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve and publish/ })).toBeNull();
  });

  it('a plugins:write holder gets Approve on an expanded row', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' || p === 'plugins:write' });
    render(<PluginsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /terraform-plan 1.4.2/ }));
    expect(await screen.findByRole('button', { name: /Approve and publish/ })).toBeTruthy();
  });

  it('says remediation is turned off by the operator', async () => {
    api.listPluginRemediations.mockImplementation(() => LIST({ enabled: false, remediations: [] }));
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' });
    render(<PluginsPage />);
    expect(await screen.findByText('Remediation is turned off by the operator')).toBeTruthy();
  });
});
