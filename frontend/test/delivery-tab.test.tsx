// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports → Delivery: the free runner reliability panel, the advanced
 * deployment calendar (locked, with NO request, without the entitlement), CSV
 * per table, empty states, and that the reads carry the org's reporting
 * timezone + week start.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, waitFor, within } from '@testing-library/react';

const mockRunners = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockCalendar = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPolicy = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.mock('@/lib/api', () => {
  const client = {
    getRunnerReliability: (...a: unknown[]) => mockRunners(...a),
    getDeploymentCalendar: (...a: unknown[]) => mockCalendar(...a),
    getReportPolicy: (...a: unknown[]) => mockPolicy(...a),
  };
  return { __esModule: true, default: client, api: client };
});

import { CalendarPanel, DeliveryTab, RunnerPanel, calendarDays } from '../src/components/reports/tabs/DeliveryTab';
import type { DeploymentCalendarReport, RunnerReliabilityReport } from '../src/lib/api/domains/reporting-delivery';

const ZERO = { requests: 0, started: 0, failed: 0, expired: 0, refused: 0, pending: 0 };
const RUNNERS: RunnerReliabilityReport = {
  window: { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
  totals: { requests: 11, started: 5, failed: 2, expired: 1, refused: 2, pending: 1, failureRatePct: 50 },
  trend: [{ period: '2026-08-31 00:00:00', ...ZERO, requests: 11, started: 5, failed: 2, expired: 1, refused: 2, pending: 1 }],
  latency: { n: 3, nExact: 2, nEstimated: 1, medianSeconds: 60, p90Seconds: 84 },
  topFailureCodes: [{ code: 'RUNNER_PERMISSION_DENIED', category: 'runner', count: 2 }, { code: 'OTHER', category: 'other', count: 1 }],
  runners: [
    { runnerId: 'r1', label: 'own-runner', ownership: 'own', health: 'unreachable', status: 'active', consecutiveFailures: 4, lastDeliveryAt: '2026-09-20T00:00:00.000Z', ...ZERO, requests: 9, started: 4, failed: 2, expired: 1, refused: 1, pending: 1, failureRatePct: 50 },
    { runnerId: 'r2', label: null, ownership: 'shared', health: null, status: null, consecutiveFailures: null, lastDeliveryAt: null, ...ZERO, requests: 1, refused: 1, failureRatePct: 100 },
  ],
};
const EMPTY_RUNNERS: RunnerReliabilityReport = {
  ...RUNNERS,
  totals: { ...ZERO, failureRatePct: null },
  trend: [{ period: '2026-08-31 00:00:00', ...ZERO }],
  latency: { n: 0, nExact: 0, nEstimated: 0, medianSeconds: null, p90Seconds: null },
  topFailureCodes: [],
  runners: [],
};
const CALENDAR: DeploymentCalendarReport = {
  window: RUNNERS.window,
  tz: 'America/Chicago',
  days: [
    { day: '2026-09-02', environment: 'production', deployments: 3, failed: 1 },
    { day: '2026-09-02', environment: 'staging', deployments: 1, failed: 0 },
    { day: '2026-09-04', environment: 'production', deployments: 1, failed: 0 },
  ],
  environments: ['production', 'staging'],
  totals: { deployments: 5, failed: 1, commits: 18 },
  commitsPerDeploy: { n: 4, median: 3, p90: 8.2 },
  productionDeploys: {
    count: 1,
    items: [{ executionId: 'd-3', pipelineId: 'p1', pipelineName: 'web-deploy', environment: 'production', deployedAt: '2026-09-03T03:00:00.000Z', commitCount: 10, outcome: 'post_deploy_failure' }],
  },
};

const FILTERS = { dateFrom: '2026-09-01', dateTo: '2026-10-01', interval: 'week' as const, includeDescendants: false };

beforeEach(() => {
  jest.clearAllMocks();
  mockRunners.mockResolvedValue(RUNNERS);
  mockCalendar.mockResolvedValue(CALENDAR);
  mockPolicy.mockResolvedValue({ data: { policy: { defaultTimezone: 'America/Chicago', defaultWeekStart: 'sunday' } } });
});

describe('calendarDays', () => {
  it('fills every day between the first and last deploy', () => {
    expect(calendarDays(CALENDAR.days)).toEqual(['2026-09-02', '2026-09-03', '2026-09-04']);
    expect(calendarDays([])).toEqual([]);
  });
});

describe('RunnerPanel', () => {
  it('renders outcomes, latency, failure codes and per-runner rows, with CSV per table', () => {
    render(<RunnerPanel loading={false} data={RUNNERS} />);
    expect(screen.getByText('Run requests')).toBeInTheDocument();
    expect(screen.getAllByText('50%').length).toBeGreaterThan(0);
    expect(screen.getByText('1m')).toBeInTheDocument();
    expect(screen.getByText('p90 1m · n = 3 (2 exact, 1 estimated)')).toBeInTheDocument();
    expect(screen.getByText('RUNNER_PERMISSION_DENIED')).toBeInTheDocument();
    const runners = screen.getByRole('table', { name: /runners/i });
    expect(within(runners).getByText('own-runner')).toBeInTheDocument();
    expect(within(runners).getByText('unreachable')).toBeInTheDocument();
    // A parent's runner that is no longer shared stays unnamed.
    expect(within(runners).getByText('Unshared runner')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /csv/i })).toHaveLength(3);
  });

  it('says when every latency sample is exact, or every one is estimated', () => {
    const { unmount } = render(<RunnerPanel loading={false} data={{ ...RUNNERS, latency: { ...RUNNERS.latency, nExact: 3, nEstimated: 0 } }} />);
    expect(screen.getByText('p90 1m · n = 3 (exact)')).toBeInTheDocument();
    unmount();
    render(<RunnerPanel loading={false} data={{ ...RUNNERS, latency: { ...RUNNERS.latency, nExact: 0, nEstimated: 3 } }} />);
    expect(screen.getByText('p90 1m · n = 3 (estimated)')).toBeInTheDocument();
  });

  it('shows an empty state for a range with no run requests', () => {
    render(<RunnerPanel loading={false} data={EMPTY_RUNNERS} />);
    expect(screen.getByText('No run requests in this range')).toBeInTheDocument();
  });
});

describe('CalendarPanel', () => {
  it('renders the heatmap, commits per deploy and the production deploys, with CSV per table', () => {
    render(<CalendarPanel loading={false} data={CALENDAR} />);
    expect(screen.getByLabelText('2026-09-02 production: 3 deployments, 1 failed')).toBeInTheDocument();
    expect(screen.getByLabelText('2026-09-03 production: 0 deployments, 0 failed')).toBeInTheDocument();
    expect(screen.getByText('p90 8.2 · n = 4')).toBeInTheDocument();
    expect(screen.getByText('web-deploy')).toBeInTheDocument();
    expect(screen.getByText('Failed after deploy')).toBeInTheDocument();
    expect(screen.getByText(/America\/Chicago/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /csv/i })).toHaveLength(2);
  });

  it('shows an empty state for a range with no deployments', () => {
    render(<CalendarPanel loading={false} data={{ ...CALENDAR, days: [], environments: [], totals: { deployments: 0, failed: 0, commits: 0 }, commitsPerDeploy: { n: 0, median: null, p90: null }, productionDeploys: { count: 0, items: [] } }} />);
    expect(screen.getByText('No deployments in this range')).toBeInTheDocument();
  });
});

describe('DeliveryTab', () => {
  it('shows the runner panel but locks the calendar, requesting nothing for it, without advanced_reporting', async () => {
    render(<DeliveryTab filters={FILTERS} advancedEnabled={false} onStatus={() => {}} />);
    await waitFor(() => expect(screen.getByText('own-runner')).toBeInTheDocument());
    expect(screen.getByText('Unlock Advanced Reporting')).toBeInTheDocument();
    expect(mockCalendar).not.toHaveBeenCalled();
  });

  it("reads both reports in the org's reporting timezone and week start", async () => {
    render(<DeliveryTab filters={FILTERS} advancedEnabled onStatus={() => {}} />);
    await waitFor(() => expect(screen.getByText('web-deploy')).toBeInTheDocument());
    const expected = { from: '2026-09-01', to: '2026-10-01', interval: 'week', tz: 'America/Chicago', weekStart: 'sunday' };
    expect(mockRunners).toHaveBeenCalledWith(expected, expect.anything());
    expect(mockCalendar).toHaveBeenCalledWith(expected, expect.anything());
  });
});
