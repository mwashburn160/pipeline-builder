// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports page: a rejected fetch must surface an inline error + retry banner
 * rather than silently rendering the empty ("No data yet") state. Regression
 * for Promise.allSettled swallowing rejected results.
 *
 * Deterministic by construction: every mocked fetch settles on the microtask
 * queue, so {@link settle} drains it (a macrotask boundary inside `act`) and the
 * assertions run synchronously. The previous `findBy*`/`waitFor` polling raced a
 * 1s wall-clock timeout, which the first (cold) render blew under full-gate CPU
 * load; tests also ended with fetches still in flight, leaking updates past
 * unmount.
 */

import { act, render, screen, fireEvent } from '@testing-library/react';
import ReportsPage from '../pages/dashboard/reports';

jest.mock('@/hooks/useAuthGuard', () => ({
  __esModule: true,
  useAuthGuard: () => ({
    isReady: true,
    isAuthenticated: true,
    user: { id: 'u1', organizationId: 'org-1', role: 'member' },
    can: () => false,
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
    listPipelines: jest.fn().mockResolvedValue({ data: { pipelines: [] } }),
    getReportEnvironments: jest.fn().mockResolvedValue({ data: { environments: [] } }),
    getOrganizationDescendants: jest.fn().mockResolvedValue({ data: { orgIds: [] } }),
  },
}));

/**
 * Let every in-flight (mocked, microtask-only) fetch settle and React flush the
 * resulting state + effects. Twice: a flush can mount a tab whose effect starts
 * the next fetch.
 */
async function settle() {
  for (let i = 0; i < 2; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

beforeEach(() => {
  getExecutionCount.mockReset().mockResolvedValue({ data: { pipelines: [] } });
  getSuccessRate.mockReset().mockResolvedValue({ data: { timeline: [] } });
  getDoraTrend.mockReset().mockResolvedValue([]);
});

describe('ReportsPage — fetch error banner', () => {
  it('shows an error + retry banner when a fetch rejects', async () => {
    getExecutionCount.mockRejectedValue(new Error('Server exploded'));

    render(<ReportsPage />);
    await settle();

    expect(screen.getByText('Server exploded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('clears the banner and refetches on Retry', async () => {
    getExecutionCount.mockRejectedValueOnce(new Error('Server exploded'));
    render(<ReportsPage />);
    await settle();
    expect(screen.getByText('Server exploded')).toBeInTheDocument();

    // Next attempt succeeds.
    getExecutionCount.mockResolvedValue({ data: { pipelines: [] } });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await settle();

    // Settled (not merely "loading", which also hides the banner): the retry
    // really succeeded.
    expect(screen.queryByText('Server exploded')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(getExecutionCount).toHaveBeenCalledTimes(2);
  });

  it('raises the banner when the DORA trend fetch rejects', async () => {
    getDoraTrend.mockRejectedValue(new Error('Trend service down'));

    render(<ReportsPage />);
    await settle();

    // DORA fetches now live on the dedicated, feature-gated DORA tab (not the
    // default pipelines/overview view) — navigate there to trigger the trend fetch.
    fireEvent.click(screen.getByRole('button', { name: /dora/i }));
    await settle();

    expect(screen.getByText('Trend service down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('does not show the banner when all fetches succeed', async () => {
    getExecutionCount.mockResolvedValue({ data: { pipelines: [] } });
    render(<ReportsPage />);
    await settle();

    // Asserted AFTER the fetches settle — before, this passed vacuously while
    // the requests were still in flight.
    expect(getExecutionCount).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
