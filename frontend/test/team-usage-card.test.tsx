// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react';
import { TeamUsageCard } from '../src/components/billing/TeamUsageCard';

let mockEnabled = true;
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ isEnabled: (f: string) => (f === 'team_usage_analytics' ? mockEnabled : true) }),
}));

const getTeamUsage = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getTeamUsage: (...a: unknown[]) => getTeamUsage(...a) },
}));

const teams = (rows: any[]) => ({ data: { teams: rows } });

beforeEach(() => {
  mockEnabled = true;
  getTeamUsage.mockReset().mockResolvedValue(teams([]));
});

describe('TeamUsageCard', () => {
  it('shows the upsell when the feature is not entitled', async () => {
    mockEnabled = false;
    render(<TeamUsageCard />);
    expect(await screen.findByText('Team Usage Analytics')).toBeInTheDocument();
    expect(screen.getByText(/add it for \$30\/mo/i)).toBeInTheDocument();
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

  it('shows the create-teams hint when entitled but single-org', async () => {
    getTeamUsage.mockResolvedValue(teams([{ orgId: 'root', name: 'Root', seats: 6, usage: {} }]));
    render(<TeamUsageCard />);
    expect(await screen.findByText(/create teams under your organization/i)).toBeInTheDocument();
  });
});
