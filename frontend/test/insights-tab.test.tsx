// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Reports → Insights tab: one card per analysis, loading / empty / failed
 * states, CSV per card, and the locked upsell (with NO fetch) for an org without
 * advanced_reporting.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import { InsightsTab, insightCsvRows, fmtBuildTime } from '../src/components/reports/tabs/InsightsTab';
import type { SharedFilters } from '../src/components/reports/useReportData';

const getInsights = jest.fn<AnyFn>();
const getReportPolicy = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getInsights: (...a: unknown[]) => getInsights(...a),
    getReportPolicy: (...a: unknown[]) => getReportPolicy(...a),
  },
}));

const filters: SharedFilters = { dateFrom: '2026-09-01', dateTo: '2026-10-01', interval: 'week', includeDescendants: true };

const RESULT = {
  window: { from: '2026-09-01T05:00:00.000Z', to: '2026-10-01T05:00:00.000Z', tz: 'America/Chicago', weekStart: 'monday', previous: { from: 'a', to: 'b' } },
  sections: [
    { id: 'needs_attention', title: 'Needs attention', state: 'ok', data: { items: [{ pipelineId: 'p1', pipelineName: 'web-deploy', severity: 'high', findings: [{ rule: 'low_success_rate', evidence: 'Success rate 40% is below 80%', severity: 'high' }] }], pipelinesEvaluated: 2, unavailableRules: [] } },
    { id: 'failure_analysis', title: 'What is breaking', state: 'failed' },
    { id: 'promotion', title: 'What reached production, and what did not', state: 'ok', data: { commits: [], stuckCount: 0 } },
    { id: 'resource_consumption', title: 'Where the build time went', state: 'ok', data: { totalBuildSeconds: 7200, pipelines: [{ project: 'web', pipelineId: 'p1', pipelineName: 'web-deploy', buildSeconds: 7200, runs: 12, sharePct: 100 }] } },
    { id: 'outdated_plugins', title: 'Plugins behind their latest version', state: 'ok', data: { rows: [], behindPipelines: 0, majorBehind: 0 } },
    { id: 'adoption', title: 'Adoption and coverage', state: 'ok', data: { totalPipelines: 3, activePipelines: 2, deployTrackedPipelines: 1, activeTeams: 1, bySource: { template: 2 }, estimatedMinutesSaved: null } },
  ],
};

beforeEach(() => {
  getInsights.mockReset().mockResolvedValue(RESULT);
  getReportPolicy.mockReset().mockResolvedValue({ data: { policy: { defaultTimezone: 'America/Chicago', defaultWeekStart: 'sunday' } } });
});

describe('InsightsTab', () => {
  it('renders the locked upsell and fetches nothing without advanced_reporting', async () => {
    const onStatus = jest.fn<AnyFn>();
    render(<InsightsTab filters={filters} enabled={false} onStatus={onStatus} />);
    expect(screen.getByRole('link', { name: /unlock advanced reporting/i }).getAttribute('href')).toBe('/dashboard/usage?tab=billing&highlight=advanced_reporting');
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ loading: false })));
    // Let the timezone read settle: the fetch would fire right after it.
    await waitFor(() => expect(getReportPolicy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(getInsights).not.toHaveBeenCalled();
  });

  it('fetches with the range, rollup and the org report timezone, and renders a card per analysis', async () => {
    render(<InsightsTab filters={filters} enabled onStatus={jest.fn<AnyFn>()} />);
    await screen.findByText('web-deploy', { selector: 'p' });
    expect(getInsights).toHaveBeenCalledWith(
      { from: '2026-09-01', to: '2026-10-01', includeDescendants: true, tz: 'America/Chicago', weekStart: 'sunday' },
      expect.anything(),
    );
    for (const title of ['Needs attention', 'What is breaking', 'Where the build time went', 'Adoption and coverage', 'Plugins behind their latest version']) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByText('Success rate 40% is below 80%')).toBeTruthy();
    // A failed section is isolated to its own card; empty ones say so.
    expect(screen.getByText(/could not be computed for this window/i)).toBeTruthy();
    expect(screen.getByText(/no commit-tagged deploys/i)).toBeTruthy();
    expect(screen.getByText(/every plugin step is on its latest version/i)).toBeTruthy();
    // CSV on every ok card, none on the failed one.
    expect(screen.getAllByTitle('Export to CSV')).toHaveLength(5);
  });

  it('shows loading skeletons until the response lands', async () => {
    let resolve: (v: unknown) => void = () => {};
    getInsights.mockReturnValue(new Promise((r) => { resolve = r; }));
    const onStatus = jest.fn<AnyFn>();
    render(<InsightsTab filters={filters} enabled onStatus={onStatus} />);
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ loading: true })));
    expect(screen.queryByText('Needs attention')).toBeNull();
    resolve(RESULT);
    await screen.findByText('Needs attention');
  });
});

describe('insightCsvRows', () => {
  it('flattens each analysis into one table', () => {
    expect(insightCsvRows('needs_attention', RESULT.sections[0]!.data as never)).toEqual([
      { pipeline: 'web-deploy', pipeline_id: 'p1', rule: 'low_success_rate', severity: 'high', evidence: 'Success rate 40% is below 80%' },
    ]);
    expect(insightCsvRows('adoption', RESULT.sections[5]!.data as never)).toEqual([{
      total_pipelines: 3, active_pipelines: 2, deploy_tracked_pipelines: 1, active_teams: 1, estimated_minutes_saved: '', created_template: 2,
    }]);
    expect(insightCsvRows('failure_analysis', undefined)).toEqual([]);
  });

  it('formats build time in seconds, never money', () => {
    expect(fmtBuildTime(7200)).toBe('2h');
    expect(fmtBuildTime(3900)).toBe('1h 5m');
    expect(fmtBuildTime(30)).toBe('30s');
  });
});
