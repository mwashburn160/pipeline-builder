// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports page: a rejected fetch must surface an inline error + retry banner
 * rather than silently rendering the empty ("No data yet") state. Regression
 * for Promise.allSettled swallowing rejected results.
 *
 * Every test waits for a SETTLED outcome — the error text, or the loaded empty
 * state — never merely "not loading", so no assertion passes vacuously while
 * requests are in flight, and no test ends with a fetch still pending. The
 * waits get a generous timeout ({@link SETTLE}): the first (cold) render of
 * this page can take well over the default 1s under full-gate CPU load.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReportsPage from '../pages/dashboard/reports';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

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

jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());

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
    listPipelines: jest.fn().mockResolvedValue({ data: { pipelines: [] } }),
    getReportEnvironments: jest.fn().mockResolvedValue({ data: { environments: [] } }),
  },
}));

/** Wait options for settled outcomes — see the file comment. */
const SETTLE = { timeout: 15_000 };
jest.setTimeout(30_000);

/** The pipelines tab after its fetches settled successfully (not merely loading). */
const loadedEmptyState = () => screen.findByText('No pipeline data yet', {}, SETTLE);

beforeEach(() => {
  getExecutionCount.mockReset().mockResolvedValue({ data: { pipelines: [] } });
  getSuccessRate.mockReset().mockResolvedValue({ data: { timeline: [] } });
  getDoraTrend.mockReset().mockResolvedValue([]);
});

describe('ReportsPage — fetch error banner', () => {
  it('shows an error + retry banner when a fetch rejects', async () => {
    getExecutionCount.mockRejectedValue(new Error('Server exploded'));

    render(<ReportsPage />);

    expect(await screen.findByText('Server exploded', {}, SETTLE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('clears the banner and refetches on Retry', async () => {
    getExecutionCount.mockRejectedValueOnce(new Error('Server exploded'));
    render(<ReportsPage />);
    expect(await screen.findByText('Server exploded', {}, SETTLE)).toBeInTheDocument();

    // Next attempt succeeds.
    getExecutionCount.mockResolvedValue({ data: { pipelines: [] } });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(getExecutionCount).toHaveBeenCalledTimes(2), SETTLE);
    await loadedEmptyState();

    // Settled (not merely "loading", which also hides the banner): the retry
    // really succeeded.
    expect(screen.queryByText('Server exploded')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(getExecutionCount).toHaveBeenCalledTimes(2);
  });

  it('raises the banner when the DORA trend fetch rejects', async () => {
    getDoraTrend.mockRejectedValue(new Error('Trend service down'));

    render(<ReportsPage />);
    await loadedEmptyState();

    // DORA fetches now live on the dedicated, feature-gated DORA tab (not the
    // default pipelines/overview view) — navigate there to trigger the trend fetch.
    fireEvent.click(screen.getByRole('button', { name: /dora/i }));

    expect(await screen.findByText('Trend service down', {}, SETTLE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('does not show the banner when all fetches succeed', async () => {
    getExecutionCount.mockResolvedValue({ data: { pipelines: [] } });
    render(<ReportsPage />);
    await loadedEmptyState();

    // Asserted AFTER the fetches settle — before, this passed vacuously while
    // the requests were still in flight.
    expect(getExecutionCount).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
