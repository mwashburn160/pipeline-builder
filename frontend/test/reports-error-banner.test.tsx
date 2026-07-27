// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports page: a rejected fetch must surface an inline error + retry banner
 * rather than silently rendering the empty ("No data yet") state. Regression
 * for Promise.allSettled swallowing rejected results.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReportsPage from '../pages/dashboard/reports';

jest.mock('@/hooks/useAuthGuard', () => ({
  __esModule: true,
  useAuthGuard: () => ({
    isReady: true,
    isAuthenticated: true,
    user: { id: 'u1', organizationId: 'org-1', role: 'member' },
  }),
}));

// DORA fetches only fire (and can raise the banner) when advanced_reporting is on.
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({
    isEnabled: () => true,
    features: [],
    isLoaded: true,
    supportAlias: 'support@pipeline-builder',
  }),
}));

jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query: {}, pathname: '/dashboard/reports', replace: jest.fn() }),
}));

// ReportTabs is loaded via next/dynamic — stub it out.
jest.mock('next/dynamic', () => ({ __esModule: true, default: () => () => null }));

jest.mock('@/components/ui/DashboardLayout', () => ({
  __esModule: true,
  DashboardLayout: ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{actions}{children}</div>
  ),
}));

const getExecutionCount = jest.fn();
const getSuccessRate = jest.fn();
const getDoraTrend = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getExecutionCount: (...a: unknown[]) => getExecutionCount(...a),
    getSuccessRate: (...a: unknown[]) => getSuccessRate(...a),
    getDora: jest.fn().mockResolvedValue(null),
    getDoraTrend: (...a: unknown[]) => getDoraTrend(...a),
    getOrganizationDescendants: jest.fn().mockResolvedValue({ data: { orgIds: [] } }),
  },
}));

beforeEach(() => {
  getExecutionCount.mockReset().mockResolvedValue({ data: { pipelines: [] } });
  getSuccessRate.mockReset().mockResolvedValue({ data: { timeline: [] } });
  getDoraTrend.mockReset().mockResolvedValue([]);
});

describe('ReportsPage — fetch error banner', () => {
  it('shows an error + retry banner when a fetch rejects', async () => {
    getExecutionCount.mockRejectedValue(new Error('Server exploded'));

    render(<ReportsPage />);

    expect(await screen.findByText('Server exploded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('clears the banner and refetches on Retry', async () => {
    getExecutionCount.mockRejectedValueOnce(new Error('Server exploded'));
    render(<ReportsPage />);
    await screen.findByText('Server exploded');

    // Next attempt succeeds.
    getExecutionCount.mockResolvedValue({ data: { pipelines: [] } });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.queryByText('Server exploded')).not.toBeInTheDocument());
    expect(getExecutionCount).toHaveBeenCalledTimes(2);
  });

  it('raises the banner when the DORA trend fetch rejects', async () => {
    getDoraTrend.mockRejectedValue(new Error('Trend service down'));

    render(<ReportsPage />);

    expect(await screen.findByText('Trend service down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('does not show the banner when all fetches succeed', async () => {
    getExecutionCount.mockResolvedValue({ data: { pipelines: [] } });
    render(<ReportsPage />);

    await waitFor(() => expect(getExecutionCount).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
