// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports → Flow: the free queue-time panel, the advanced approvals panel and
 * queue trend (locked, and NOT requested, without the entitlement), their empty
 * states (which say the data is collected for runs after this release), the CSV
 * button per table, and that every read carries the org's reporting timezone +
 * week start.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';

const mockApprovals = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockQueue = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockTrend = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPolicy = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.mock('@/lib/api', () => {
  const client = {
    getApprovalWaits: (...a: unknown[]) => mockApprovals(...a),
    getQueueWaits: (...a: unknown[]) => mockQueue(...a),
    getQueueWaitTrend: (...a: unknown[]) => mockTrend(...a),
    getReportPolicy: (...a: unknown[]) => mockPolicy(...a),
  };
  return { __esModule: true, default: client, api: client };
});

import { ApprovalsPanel, FlowTab, QueuePanel, QueueTrendPanel, fmtWait } from '../src/components/reports/tabs/FlowTab';
import type { ApprovalWaitReport, QueueTrendPoint, QueueWaitReport } from '../src/lib/api/domains/reporting-flow';

const WINDOW = { from: '2026-09-01T05:00:00.000Z', to: '2026-10-01T05:00:00.000Z' };
const APPROVALS: ApprovalWaitReport = {
  window: WINDOW,
  totals: { approvals: 4, approved: 2, rejectedOrExpired: 1, undecided: 1, wait: { n: 3, medianSeconds: 1200, p90Seconds: 1680 } },
  trend: [{ period: '2026-08-31 00:00:00', approvals: 4, approved: 2, rejectedOrExpired: 1, undecided: 1, medianSeconds: 1200, p90Seconds: 1680 }],
  slowestStages: [{ pipelineId: 'p1', pipelineName: 'web-deploy', stageName: 'Release', approvals: 2, rejectedOrExpired: 1, medianSeconds: 1200, p90Seconds: 1680, maxSeconds: 1800 }],
};
const EMPTY_APPROVALS: ApprovalWaitReport = {
  ...APPROVALS,
  totals: { approvals: 0, approved: 0, rejectedOrExpired: 0, undecided: 0, wait: { n: 0, medianSeconds: null, p90Seconds: null } },
  trend: [{ period: '2026-08-31 00:00:00', approvals: 0, approved: 0, rejectedOrExpired: 0, undecided: 0, medianSeconds: null, p90Seconds: null }],
  slowestStages: [],
};
const QUEUE: QueueWaitReport = {
  window: WINDOW,
  builds: 5,
  queue: { n: 5, medianSeconds: 20, p90Seconds: 72 },
  provisioning: { n: 4, medianSeconds: 30, p90Seconds: 54 },
  byComputeType: [{ computeType: 'MEDIUM', builds: 5, queueMedianSeconds: 20, queueP90Seconds: 72, provisioningMedianSeconds: 30, provisioningP90Seconds: 54 }],
  slowestActions: [{ pipelineId: 'p1', pipelineName: 'api-build', stageName: 'Build', actionName: 'Synth', builds: 1, queueMedianSeconds: 100, queueP90Seconds: 100, provisioningMedianSeconds: 60, provisioningP90Seconds: 60, totalWaitP90Seconds: 160 }],
  startToFirstStage: { n: 2, medianSeconds: 60, p90Seconds: 84 },
};
const EMPTY_QUEUE: QueueWaitReport = {
  ...QUEUE,
  builds: 0,
  queue: { n: 0, medianSeconds: null, p90Seconds: null },
  provisioning: { n: 0, medianSeconds: null, p90Seconds: null },
  byComputeType: [],
  slowestActions: [],
  startToFirstStage: { n: 0, medianSeconds: null, p90Seconds: null },
};
const TREND: QueueTrendPoint[] = [{
  period: '2026-08-31 00:00:00', builds: 2, queueMedianSeconds: 20, queueP90Seconds: 28, provisioningMedianSeconds: 30,
  provisioningP90Seconds: 38, executions: 1, startToFirstStageMedianSeconds: 30, startToFirstStageP90Seconds: 30,
}];

const FILTERS = { dateFrom: '2026-09-01', dateTo: '2026-10-01', interval: 'week' as const, includeDescendants: false };

beforeEach(() => {
  jest.clearAllMocks();
  mockApprovals.mockResolvedValue(APPROVALS);
  mockQueue.mockResolvedValue(QUEUE);
  mockTrend.mockResolvedValue(TREND);
  mockPolicy.mockResolvedValue({ data: { policy: { defaultTimezone: 'America/Chicago', defaultWeekStart: 'sunday' } } });
});

describe('fmtWait', () => {
  it('keeps seconds for short waits and picks the unit for long ones', () => {
    expect(fmtWait(null)).toBe('—');
    expect(fmtWait(42)).toBe('42s');
    expect(fmtWait(600)).toBe('10m');
    expect(fmtWait(7200)).toBe('2.0h');
    expect(fmtWait(2 * 86_400)).toBe('2.0d');
  });
});

describe('ApprovalsPanel', () => {
  it('renders the counts, waits and slowest stages, with CSV per table', () => {
    render(<ApprovalsPanel loading={false} data={APPROVALS} />);
    expect(screen.getByText('Manual approvals')).toBeInTheDocument();
    expect(screen.getByText('2 approved')).toBeInTheDocument();
    expect(screen.getByText('1 without a decision')).toBeInTheDocument();
    expect(screen.getAllByText('20m').length).toBeGreaterThan(0);
    expect(screen.getByText('web-deploy')).toBeInTheDocument();
    expect(screen.getByText('2026-08-31')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /csv/i })).toHaveLength(2);
  });

  it('explains an empty range: data is collected for runs after this release', () => {
    render(<ApprovalsPanel loading={false} data={EMPTY_APPROVALS} />);
    expect(screen.getByText('No manual approvals finished in this range')).toBeInTheDocument();
    expect(screen.getByText(/collected for runs after this release/i)).toBeInTheDocument();
  });
});

describe('QueuePanel', () => {
  it('renders queue, provisioning, start to first stage, by compute type and the longest waits', () => {
    render(<QueuePanel loading={false} data={QUEUE} />);
    expect(screen.getByText('Median queue time')).toBeInTheDocument();
    expect(screen.getByText('p90 72s · n = 5')).toBeInTheDocument();
    expect(screen.getByText('p90 84s · n = 2')).toBeInTheDocument();
    expect(screen.getByText('MEDIUM')).toBeInTheDocument();
    expect(screen.getByText('Synth')).toBeInTheDocument();
    expect(screen.getByText('3m')).toBeInTheDocument(); // 160s total p90
    expect(screen.getAllByRole('button', { name: /csv/i })).toHaveLength(2);
  });

  it('explains an empty range', () => {
    render(<QueuePanel loading={false} data={EMPTY_QUEUE} />);
    expect(screen.getByText('No build queue times in this range')).toBeInTheDocument();
    expect(screen.getByText(/collected for runs after this release/i)).toBeInTheDocument();
  });
});

describe('QueueTrendPanel', () => {
  it('renders one row per period with a CSV button', () => {
    render(<QueueTrendPanel loading={false} data={TREND} />);
    expect(screen.getByText('2026-08-31')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /csv/i })).toHaveLength(1);
  });

  it('explains an empty series', () => {
    render(<QueueTrendPanel loading={false} data={[{ ...TREND[0]!, builds: 0, executions: 0 }]} />);
    expect(screen.getByText('No queue time to trend in this range')).toBeInTheDocument();
  });
});

describe('FlowTab', () => {
  it('shows the free queue figures and locks approvals + the trend without advanced_reporting (no request for them)', async () => {
    render(<FlowTab filters={FILTERS} advancedEnabled={false} onStatus={() => {}} />);
    await waitFor(() => expect(screen.getByText('Synth')).toBeInTheDocument());
    expect(screen.getAllByText('Unlock Advanced Reporting')).toHaveLength(2);
    expect(mockQueue).toHaveBeenCalled();
    expect(mockApprovals).not.toHaveBeenCalled();
    expect(mockTrend).not.toHaveBeenCalled();
  });

  it("reads every report in the org's reporting timezone and week start when entitled", async () => {
    render(<FlowTab filters={FILTERS} advancedEnabled onStatus={() => {}} />);
    await waitFor(() => expect(screen.getByText('web-deploy')).toBeInTheDocument());
    const expected = { from: '2026-09-01', to: '2026-10-01', interval: 'week', tz: 'America/Chicago', weekStart: 'sunday' };
    expect(mockQueue).toHaveBeenCalledWith(expected, expect.anything());
    expect(mockTrend).toHaveBeenCalledWith(expected, expect.anything());
    expect(mockApprovals).toHaveBeenCalledWith(expected, expect.anything());
    expect(screen.queryByText('Unlock Advanced Reporting')).not.toBeInTheDocument();
  });
});
