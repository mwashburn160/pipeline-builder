// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';
import { TeamUsageCard } from '../src/components/billing/TeamUsageCard';
import { mockOrgHierarchy } from './helpers/pageMocks';

jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());

let mockEnabled = true;
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  // `canReachBilling` = this viewer can open /dashboard/billing (`billing:read`,
  // billing enabled). A lock only links there when they can; see feature-lock.test.tsx.
  useFeatures: () => ({ isEnabled: (f: string) => (f === 'team_usage_analytics' ? mockEnabled : true), isLoaded: true, isSuperAdmin: false, canReachBilling: true }),
}));

const getTeamUsage = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getTeamUsage: (...a: unknown[]) => getTeamUsage(...a) },
}));

const teams = (rows: any[]) => ({ data: { teams: rows } });

beforeEach(() => {
  mockEnabled = true;
  mockOrgHierarchy({ childOrgCount: 2 });
  getTeamUsage.mockReset().mockResolvedValue(teams([]));
});

describe('TeamUsageCard', () => {
  it('shows the upsell when the feature is not entitled', async () => {
    mockEnabled = false;
    render(<TeamUsageCard />);
    // The shared lock (not hand-written price copy), linking to the billing add-on.
    expect(await screen.findByTestId('feature-lock-team_usage_analytics')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see it in billing/i })).toHaveAttribute('href', '/dashboard/billing?highlight=team_usage_analytics');
    expect(getTeamUsage).not.toHaveBeenCalled();
  });

  it('renders the per-team usage table (usage-only) when entitled with teams', async () => {
    getTeamUsage.mockResolvedValue(teams([
      { orgId: 'root', name: 'Root', seats: 6, usage: { pipelines: 4, apiCalls: 1200, storageBytes: 1073741824 } },
      { orgId: 'team-a', name: 'Team A', seats: 2, usage: { pipelines: 1, apiCalls: 300, storageBytes: null } },
    ]));
    render(<TeamUsageCard />);
    expect(await screen.findByText('Team usage')).toBeInTheDocument();
    expect(screen.getByText('Team A')).toBeInTheDocument();
    expect(screen.getByText(/limits are account-wide/i)).toBeInTheDocument();
    // Fail-soft null cell renders as an em dash, not NaN.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders nothing — no upsell, no request — for an org with no teams', () => {
    mockOrgHierarchy({ childOrgCount: 0 });
    const { container } = render(<TeamUsageCard />);
    expect(container).toBeEmptyDOMElement();
    expect(getTeamUsage).not.toHaveBeenCalled();
  });

  it('hides the upsell too when an unentitled org has no teams', () => {
    mockEnabled = false;
    mockOrgHierarchy({ childOrgCount: 0 });
    const { container } = render(<TeamUsageCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a retryable error when the load fails, and reloads on Retry', async () => {
    getTeamUsage.mockRejectedValueOnce(new Error('boom'));
    render(<TeamUsageCard />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    getTeamUsage.mockResolvedValue(teams([{ orgId: 'team-a', name: 'Team A', seats: 2, usage: {} }]));
    fireEvent.click(retry);
    expect(await screen.findByText('Team A')).toBeInTheDocument();
    expect(getTeamUsage).toHaveBeenCalledTimes(2);
  });
});
