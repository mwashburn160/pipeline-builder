// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Period-over-period comparison on the dashboards (`?compare=previous`,
 * advanced_reporting): the delta arithmetic and good/bad colouring per metric
 * direction, the DORA card chips (only when entitled, and only when the
 * comparison read agrees with the figures on screen), and the success-rate
 * chip on the Pipelines overview.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';

const mockDoraComparison = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockSuccessComparison = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPolicy = jest.fn<(...a: unknown[]) => Promise<unknown>>();
let entitled = true;

jest.mock('@/lib/api', () => {
  const client = {
    getDoraComparison: (...a: unknown[]) => mockDoraComparison(...a),
    getSuccessRateComparison: (...a: unknown[]) => mockSuccessComparison(...a),
    getReportPolicy: (...a: unknown[]) => mockPolicy(...a),
  };
  return { __esModule: true, default: client, api: client };
});
jest.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({ isEnabled: (f: string) => entitled && f === 'advanced_reporting' }),
}));

import { metricDelta, DeltaChip } from '../src/components/reports/DoraParts';
import { DoraReport, doraDeltas } from '../src/components/reports/DoraReport';
import { SuccessRateComparison, timelineSuccessPct } from '../src/components/reports/tabs/PipelinesTab';
import type { DoraMetrics } from '../src/lib/api/domains/reporting';

const dora = (over: { deployments: number; rate: number; attempts: number; lead: number | null; mttr: number | null }, window = { from: '2026-11-11T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' }): DoraMetrics => ({
  window,
  filters: { pipelineId: null, environment: null },
  headline: 'production',
  environments: [{
    environment: 'production',
    deploymentFrequency: { deployments: over.deployments, perDay: over.deployments / 10, level: 'high', n: over.deployments },
    leadTime: { deployments: over.deployments, medianSeconds: over.lead, p90Seconds: null, p95Seconds: null, level: 'elite', n: over.deployments, unknownReasons: {} },
    changeFailureRate: { rate: over.rate, deployTimeFailures: 1, postDeployFailures: 0, attempts: over.attempts, level: 'medium', n: over.attempts },
  }],
  meanTimeToRestore: { medianSeconds: over.mttr, incidents: 1, restored: 1, p90Seconds: null, p95Seconds: null, level: 'elite', n: 1 },
  coverage: { registered: 1, deploying: 1, withoutDeploys: 0 },
});

const CURRENT = dora({ deployments: 12, rate: 10, attempts: 10, lead: 3600, mttr: 600 });
const PREVIOUS = dora({ deployments: 8, rate: 25, attempts: 8, lead: 1800, mttr: 600 }, { from: '2026-10-31T23:59:59.999Z', to: '2026-11-10T23:59:59.999Z' });

const doraScope = {
  pipelineId: '', environment: '',
  onPipelineChange: jest.fn<AnyFn>(), onEnvironmentChange: jest.fn<AnyFn>(), onEnvironmentCommit: jest.fn<AnyFn>(),
};
const baseProps = {
  loading: false, doraTrend: [], pipelineOptions: [], executions: [], environmentOptions: [], deployments: [],
  deployPipelineSelected: false, markEnvironment: 'production', canMark: false,
  onMarkOutcome: jest.fn<AnyFn>().mockResolvedValue(undefined), doraScope,
};

beforeEach(() => {
  jest.clearAllMocks();
  entitled = true;
  mockPolicy.mockResolvedValue({ data: { policy: { defaultTimezone: 'America/Chicago', defaultWeekStart: 'sunday' } } });
  mockDoraComparison.mockResolvedValue({ dora: CURRENT, previous: PREVIOUS });
});

describe('metricDelta', () => {
  it('colours by the metric direction', () => {
    expect(metricDelta(12, 8, 'higher', 0)).toEqual({ delta: 4, direction: 'up', tone: 'good' });
    expect(metricDelta(8, 12, 'higher', 0)).toEqual({ delta: -4, direction: 'down', tone: 'bad' });
    // Lower is better for failure rate / lead time / time to restore.
    expect(metricDelta(10, 25, 'lower')).toEqual({ delta: -15, direction: 'down', tone: 'good' });
    expect(metricDelta(3600, 1800, 'lower', 0)).toEqual({ delta: 1800, direction: 'up', tone: 'bad' });
  });

  it('rounds to the display precision and reads a sub-precision change as flat', () => {
    expect(metricDelta(92.14, 88.9, 'higher')).toEqual({ delta: 3.2, direction: 'up', tone: 'good' });
    expect(metricDelta(90.04, 90.0, 'higher')).toEqual({ delta: 0, direction: 'flat', tone: 'neutral' });
  });

  it('is null against an unknown side', () => {
    expect(metricDelta(null, 5, 'lower')).toBeNull();
    expect(metricDelta(5, undefined, 'lower')).toBeNull();
  });
});

describe('DeltaChip', () => {
  it('says the change and whether it is better in words, not colour alone', () => {
    render(<DeltaChip delta={{ delta: -15, direction: 'down', tone: 'good' }} text="−15 pts" previousText="25%" />);
    const chip = screen.getByTestId('delta-chip');
    expect(chip).toHaveAttribute('aria-label', 'Down −15 pts vs the previous period (better)');
    expect(chip).toHaveAttribute('data-tone', 'good');
  });
});

describe('doraDeltas', () => {
  it('compares the same environment the cards show', () => {
    const d = doraDeltas(CURRENT.environments[0], CURRENT, PREVIOUS);
    render(<div>{d.deploymentFrequency}{d.changeFailureRate}{d.leadTime}{d.timeToRestore}</div>);
    const chips = screen.getAllByTestId('delta-chip');
    expect(chips.map((c) => [c.getAttribute('data-tone'), c.getAttribute('aria-label')])).toEqual([
      ['good', 'Up +4 vs the previous period (better)'],
      ['good', 'Down −15 pts vs the previous period (better)'],
      ['bad', expect.stringMatching(/^Up \+30m vs the previous period \(worse\)$/)],
      ['neutral', 'No change vs the previous period'],
    ]);
  });

  it('treats an environment missing from the previous window as zero deploys and no rate', () => {
    const empty = { ...PREVIOUS, environments: [] };
    const d = doraDeltas(CURRENT.environments[0], CURRENT, empty);
    expect(d.changeFailureRate).toBeUndefined();
    expect(d.leadTime).toBeUndefined();
    render(<div>{d.deploymentFrequency}</div>);
    expect(screen.getByTestId('delta-chip')).toHaveAttribute('aria-label', 'Up +12 vs the previous period (better)');
  });
});

describe('DoraReport comparison chips', () => {
  it('reads the comparison for the window on screen and shows the chips when entitled', async () => {
    render(<DoraReport {...baseProps} dora={CURRENT} includeDescendants />);
    await waitFor(() => expect(screen.getAllByTestId('delta-chip')).toHaveLength(4));
    expect(mockDoraComparison).toHaveBeenCalledWith(
      { from: CURRENT.window.from, to: CURRENT.window.to, includeDescendants: true },
      expect.anything(),
    );
  });

  it('shows no chip and reads nothing without advanced_reporting (the free tier gets no comparison)', async () => {
    entitled = false;
    render(<DoraReport {...baseProps} dora={CURRENT} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockDoraComparison).not.toHaveBeenCalled();
    expect(screen.queryByTestId('delta-chip')).toBeNull();
  });

  it('hides the chips when the comparison read disagrees with the figures on screen', async () => {
    mockDoraComparison.mockResolvedValue({ dora: dora({ deployments: 99, rate: 10, attempts: 10, lead: 3600, mttr: 600 }), previous: PREVIOUS });
    render(<DoraReport {...baseProps} dora={CURRENT} />);
    await waitFor(() => expect(mockDoraComparison).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('delta-chip')).toBeNull();
  });

  it('shows no chip when the previous window is past retention (previous: null)', async () => {
    mockDoraComparison.mockResolvedValue({ dora: CURRENT, previous: null });
    render(<DoraReport {...baseProps} dora={CURRENT} />);
    await waitFor(() => expect(mockDoraComparison).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('delta-chip')).toBeNull();
  });
});

describe('the success-rate comparison', () => {
  const FILTERS = { dateFrom: '2026-11-11', dateTo: '2026-11-21', interval: 'week' as const, includeDescendants: false };
  const pt = (succeeded: number, failed: number, canceled = 0) => ({ period: 'p', succeeded, failed, canceled, success_pct: 0 });

  it('sums the timeline into one rate', () => {
    expect(timelineSuccessPct([pt(9, 1), pt(8, 1, 1)])).toBe(85);
    expect(timelineSuccessPct([])).toBeNull();
  });

  it("reads both windows in the org's bucketing and shows the delta in points", async () => {
    mockSuccessComparison.mockResolvedValue({
      timeline: [pt(9, 1)],
      previous: { window: { from: 'a', to: 'b' }, timeline: [pt(8, 2)] },
    });
    render(<SuccessRateComparison filters={FILTERS} />);
    await waitFor(() => expect(screen.getByTestId('delta-chip')).toHaveAttribute('aria-label', 'Up +10 pts vs the previous period (better)'));
    expect(mockSuccessComparison).toHaveBeenCalledWith(
      { interval: 'week', from: '2026-11-11', to: '2026-11-21', tz: 'America/Chicago', weekStart: 'sunday' },
      expect.anything(),
    );
    expect(screen.getByText('90%')).toBeInTheDocument();
  });

  it('renders nothing when the previous window is not comparable', async () => {
    mockSuccessComparison.mockResolvedValue({ timeline: [pt(9, 1)], previous: null });
    const { container } = render(<SuccessRateComparison filters={FILTERS} />);
    await waitFor(() => expect(mockSuccessComparison).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
