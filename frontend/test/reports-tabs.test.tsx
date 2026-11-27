// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports: the ten reports sit in five tabs (Overview, Delivery, Quality,
 * Security, Stakeholder), and every old single-level `?tab=` key still opens
 * the same report.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ isEnabled: () => true, features: [], isLoaded: true, supportAlias: 'support@pipeline-builder' }),
}));
const replace = jest.fn<AnyFn>();
let query: Record<string, string> = {};
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query, pathname: '/dashboard/reports', replace })));
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => () => Promise.resolve({ success: true, data: {} }) }),
}));
// Each report reduced to a marker naming it.
const stub = (name: string) => ({ __esModule: true, [name]: () => <div data-testid="report">{name}</div> });
jest.mock('@/components/reports/tabs/PipelinesTab', () => stub('PipelinesTab'));
jest.mock('@/components/reports/tabs/PluginsTab', () => stub('PluginsTab'));
jest.mock('@/components/reports/tabs/TeamsTab', () => stub('TeamsTab'));
jest.mock('@/components/reports/tabs/DoraTab', () => stub('DoraTab'));
jest.mock('@/components/reports/tabs/DeliveryTab', () => stub('DeliveryTab'));
jest.mock('@/components/reports/tabs/FlowTab', () => stub('FlowTab'));
jest.mock('@/components/reports/tabs/ScorecardTab', () => stub('ScorecardTab'));
jest.mock('@/components/reports/tabs/InsightsTab', () => stub('InsightsTab'));
jest.mock('@/components/reports/tabs/SecurityTab', () => stub('SecurityTab'));
jest.mock('@/components/reports/tabs/StakeholderTab', () => stub('StakeholderTab'));

import ReportsPage from '../pages/dashboard/reports';

beforeEach(() => {
  query = {};
  replace.mockClear();
  mockAuthGuard({ can: () => true });
});

describe('Reports tabs', () => {
  it('has five tabs, Overview first on the pipelines report', async () => {
    render(<ReportsPage />);
    const bar = screen.getByRole('tablist', { name: 'Report sections' });
    expect(within(bar).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Delivery', 'Quality', 'Security', 'Stakeholder']);
    const subs = within(screen.getByRole('tablist', { name: 'Overview sections' })).getAllByRole('tab');
    expect(subs.map((t) => t.textContent)).toEqual(['Pipelines', 'Plugins', 'Teams']);
    expect(await screen.findByTestId('report')).toHaveTextContent('PipelinesTab');
  });

  it('switching tab writes the new keys and drops the old report\'s own sub-tab', () => {
    query = { tab: 'overview', section: 'pipelines', sub: 'failures' };
    render(<ReportsPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery' }));
    const written = (replace.mock.calls.at(-1)?.[0] as { query: Record<string, string> }).query;
    expect(written).toEqual({ tab: 'delivery' });
    expect(within(screen.getByRole('tablist', { name: 'Delivery sections' })).getAllByRole('tab').map((t) => t.textContent))
      .toEqual(['Reliability', 'DORA', 'Flow']);
    fireEvent.click(screen.getByRole('tab', { name: 'DORA' }));
    expect((replace.mock.calls.at(-1)?.[0] as { query: Record<string, string> }).query).toEqual({ tab: 'delivery', section: 'dora' });
  });

  it.each([
    ['overview', 'pipelines', 'Overview', 'Pipelines', 'PipelinesTab'],
    ['overview', 'plugins', 'Overview', 'Plugins', 'PluginsTab'],
    ['overview', 'teams', 'Overview', 'Teams', 'TeamsTab'],
    ['delivery', 'delivery', 'Delivery', 'Reliability', 'DeliveryTab'],
    ['delivery', 'dora', 'Delivery', 'DORA', 'DoraTab'],
    ['delivery', 'flow', 'Delivery', 'Flow', 'FlowTab'],
    ['quality', 'scorecard', 'Quality', 'Scorecard', 'ScorecardTab'],
    ['quality', 'insights', 'Quality', 'Insights', 'InsightsTab'],
  ])('?tab=%s&section=%s opens %s, on %s', async (tabKey, section, top, sub, body) => {
    query = { tab: tabKey, section };
    render(<ReportsPage />);
    expect(screen.getByRole('tab', { name: top })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: sub })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('report')).toHaveTextContent(body);
  });

  it.each([
    ['security', 'Security', 'SecurityTab'],
    ['stakeholder', 'Stakeholder', 'StakeholderTab'],
  ])('?tab=%s is a whole tab, with no sub-tabs', async (key, top, body) => {
    query = { tab: key };
    render(<ReportsPage />);
    expect(screen.getByRole('tab', { name: top })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tablist', { name: `${top} sections` })).toBeNull();
    expect(await screen.findByTestId('report')).toHaveTextContent(body);
  });
});
