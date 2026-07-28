// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Render test for the DORA metrics section on the reports page: asserts the 4
 * cards, the lead-time approximation labelling, MTTR humanization, the
 * null → "—" fallback, the performance-level badge, the reporting-window line,
 * and the `advanced_reporting` feature gate.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import type { DoraMetrics } from '../src/lib/api/domains/reporting';
import { fmtWindow, doraLevelBadge } from '../src/components/reports/ReportHelpers';
import ReportsPage from '../pages/dashboard/reports';

jest.mock('@/hooks/useAuthGuard', () => ({
  __esModule: true,
  useAuthGuard: () => ({
    isReady: true,
    isAuthenticated: true,
    user: { id: 'u1', organizationId: 'org-1', role: 'member' },
  }),
}));

// Toggle for the `advanced_reporting` entitlement — flipped per-test.
let mockDoraEnabled = true;
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({
    isEnabled: (f: string) => (f === 'advanced_reporting' ? mockDoraEnabled : true),
    features: [],
    isLoaded: true,
    supportAlias: 'support@pipeline-builder',
  }),
}));

jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query: {}, pathname: '/dashboard/reports', replace: jest.fn() }),
}));

jest.mock('next/dynamic', () => ({ __esModule: true, default: () => () => null }));

jest.mock('@/components/ui/DashboardLayout', () => ({
  __esModule: true,
  DashboardLayout: ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{actions}{children}</div>
  ),
}));

const getDora = jest.fn();
const getDoraTrend = jest.fn();
const getExecutionCount = jest.fn();
const listPipelines = jest.fn();
const getReportEnvironments = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getExecutionCount: (...a: unknown[]) => getExecutionCount(...a),
    getSuccessRate: jest.fn().mockResolvedValue({ data: { timeline: [] } }),
    getDora: (...a: unknown[]) => getDora(...a),
    getDoraTrend: (...a: unknown[]) => getDoraTrend(...a),
    listPipelines: (...a: unknown[]) => listPipelines(...a),
    getReportEnvironments: (...a: unknown[]) => getReportEnvironments(...a),
    getOrganizationDescendants: jest.fn().mockResolvedValue({ data: { orgIds: [] } }),
  },
}));

/** Build one ExecutionCountRow-shaped pipeline for the overview list. */
const pipelineRow = (id: string, name: string) => ({
  id, project: name, organization: 'org-1', pipeline_name: name,
  total: 10, succeeded: 8, failed: 2, canceled: 0,
  first_execution: null, last_execution: null,
});

const baseDora: DoraMetrics = {
  window: { from: '2026-06-27T00:00:00.000Z', to: '2026-07-27T00:00:00.000Z' },
  basis: 'run',
  filters: { pipelineId: null, environment: null },
  deploymentFrequency: { deployments: 8, perDay: 0.27, level: 'high' },
  changeFailureRate: { failed: 2, total: 8, pct: 25, level: 'medium' },
  meanTimeToRestore: { failures: 2, restored: 2, avgSeconds: 3720, level: 'high' },
  leadTime: { deployments: 8, medianSeconds: 330, approx: true, level: 'elite' },
};

beforeEach(() => {
  mockDoraEnabled = true;
  getDora.mockReset();
  getDoraTrend.mockReset().mockResolvedValue([]);
  getExecutionCount.mockReset().mockResolvedValue({ data: { pipelines: [] } });
  listPipelines.mockReset().mockResolvedValue({ data: { pipelines: [] } });
  getReportEnvironments.mockReset().mockResolvedValue({ data: { environments: [] } });
});

describe('ReportsPage — DORA section', () => {
  it('renders 4 DORA cards with humanized MTTR and an approximation-labelled lead time', async () => {
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);

    expect(await screen.findByText('Deployment Frequency')).toBeInTheDocument();
    expect(screen.getByText('Change Failure Rate')).toBeInTheDocument();
    expect(screen.getByText('Time to Restore (MTTR)')).toBeInTheDocument();
    // Lead time is labelled as an approximation.
    expect(screen.getAllByText(/Lead time/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/median successful pipeline run time/i)).toBeInTheDocument();

    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('2/8 deploys failed')).toBeInTheDocument();
    // MTTR humanization: 3720s → "1h 2m".
    expect(screen.getByText('1h 2m')).toBeInTheDocument();
    // Lead time humanization: 330s → "5m 30s".
    expect(screen.getByText('5m 30s')).toBeInTheDocument();
  });

  it('renders performance-level badges from each metric level', async () => {
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);

    await screen.findByText('Deployment Frequency');
    // elite (lead time) + high (deploy freq + MTTR) + medium (CFR) bands surface as pills.
    expect(screen.getByText('Elite')).toBeInTheDocument();
    expect(screen.getAllByText('High').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Medium')).toBeInTheDocument();
  });

  it('surfaces the reporting window and the run-basis indicator', async () => {
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);

    await screen.findByText('Deployment Frequency');
    // Window renders as "Jun … – Jul …, 2026" (locale/TZ-formatted — assert the
    // year-bearing end of the range to stay timezone-robust in CI).
    expect(screen.getByText(/–\s*Jul \d{1,2}, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Counting pipeline runs/i)).toBeInTheDocument();
  });

  it('shows "—" for MTTR when avgSeconds is null (none restored) with its tooltip label', async () => {
    getDora.mockResolvedValue({
      ...baseDora,
      changeFailureRate: { failed: 0, total: 3, pct: 0, level: null },
      meanTimeToRestore: { failures: 0, restored: 0, avgSeconds: null, level: null },
      leadTime: { deployments: 3, medianSeconds: null, approx: true, level: null },
    });

    render(<ReportsPage />);

    expect(await screen.findByText('Time to Restore (MTTR)')).toBeInTheDocument();
    expect(screen.getByText('0/0 incidents restored')).toBeInTheDocument();
    // Both MTTR and lead-time values fall back to the em dash.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('hides the DORA section when advanced_reporting is disabled', async () => {
    mockDoraEnabled = false;
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);

    // With DORA gated off and no other overview data, the empty state renders.
    // Assert the DORA heading is absent and the gated fetches were never issued.
    await screen.findByText('No pipeline data yet');
    expect(screen.queryByText('DORA Metrics')).not.toBeInTheDocument();
    expect(screen.queryByText('Deployment Frequency')).not.toBeInTheDocument();
    expect(getDora).not.toHaveBeenCalled();
    expect(getDoraTrend).not.toHaveBeenCalled();
  });

  it('shows the DORA section when advanced_reporting is enabled', async () => {
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);

    expect(await screen.findByText('DORA Metrics')).toBeInTheDocument();
    expect(getDora).toHaveBeenCalled();
    expect(getDoraTrend).toHaveBeenCalled();
  });

  it('renders the locked upsell + CTA (and no DORA cards / no fetch) when not entitled', async () => {
    mockDoraEnabled = false;
    // Overview has execution data so the section area renders (the upsell sits
    // where the DORA section would be, not in the zero-data empty state).
    getExecutionCount.mockResolvedValue({ data: { pipelines: [pipelineRow('p1', 'Pipe One')] } });
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);

    // CTA deep-links to the add-on on billing.
    const cta = await screen.findByRole('link', { name: /unlock advanced reporting/i });
    expect(cta).toHaveAttribute('href', '/dashboard/billing?highlight=advanced_reporting');
    // The real DORA section is NOT rendered — its run-based footnote (which the
    // blurred teaser does not include) is absent — and the gated fetches never fire.
    expect(screen.queryByText(/These are run-based/i)).not.toBeInTheDocument();
    expect(getDora).not.toHaveBeenCalled();
    expect(getDoraTrend).not.toHaveBeenCalled();
  });

  it('forwards pipelineId to getDora + getDoraTrend when a pipeline is picked', async () => {
    getExecutionCount.mockResolvedValue({ data: { pipelines: [pipelineRow('p1', 'Pipe One')] } });
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);
    await screen.findByText('DORA Metrics');

    getDora.mockClear();
    getDoraTrend.mockClear();
    fireEvent.change(screen.getByLabelText(/filter dora by pipeline/i), { target: { value: 'p1' } });

    await screen.findByText('DORA Metrics');
    expect(getDora).toHaveBeenLastCalledWith(expect.objectContaining({ pipelineId: 'p1' }));
    expect(getDoraTrend).toHaveBeenLastCalledWith(expect.objectContaining({ pipelineId: 'p1' }));
  });

  it('lists registry pipelines in the picker even with zero execution history', async () => {
    // No runs → getExecutionCount empty; the picker is now sourced from the
    // pipeline registry, so a never-run pipeline is still selectable.
    getExecutionCount.mockResolvedValue({ data: { pipelines: [] } });
    listPipelines.mockResolvedValue({ data: { pipelines: [{ id: 'p9', project: 'proj-x', pipelineName: 'Never Run' }] } });
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);
    await screen.findByText('DORA Metrics');

    const picker = screen.getByLabelText(/filter dora by pipeline/i) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toContain('Never Run');
  });

  it('forwards deploysOnly when the deployments-only toggle is checked', async () => {
    getExecutionCount.mockResolvedValue({ data: { pipelines: [pipelineRow('p1', 'Pipe One')] } });
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);
    await screen.findByText('DORA Metrics');

    getDora.mockClear();
    getDoraTrend.mockClear();
    fireEvent.click(screen.getByLabelText(/deployments only/i));

    await screen.findByText('DORA Metrics');
    expect(getDora).toHaveBeenLastCalledWith(expect.objectContaining({ deploysOnly: true }));
    expect(getDoraTrend).toHaveBeenLastCalledWith(expect.objectContaining({ deploysOnly: true }));
  });

  it('renders the deployment-trend sparkline (bars, sr-only table, role="img" summary) when trend points exist', async () => {
    getDora.mockResolvedValue(baseDora);
    getDoraTrend.mockResolvedValue([
      { period: '2026-07-01T00:00:00.000Z', deployments: 3, failed: 1, total: 3, changeFailurePct: 33 },
      { period: '2026-07-08T00:00:00.000Z', deployments: 5, failed: 0, total: 5, changeFailurePct: 0 },
    ]);

    render(<ReportsPage />);

    // Section heading + the role="img" summary conveyed to assistive tech.
    await screen.findByText('Deployment Trend');
    const chart = screen.getByRole('img', { name: /deployment trend over 2 periods/i });
    expect(chart).toBeInTheDocument();
    // The visually-hidden per-period data table mirrors the bars.
    expect(screen.getByText('Deployments and change-failure rate per period')).toBeInTheDocument();
    // The 33% bucket is tagged as elevated in the sr-only table.
    expect(screen.getByText('Elevated change-failure')).toBeInTheDocument();
  });

  it('shows the deployment-scoped indicator (with environment) for basis "deploy"', async () => {
    getDora.mockResolvedValue({
      ...baseDora,
      basis: 'deploy',
      filters: { pipelineId: null, environment: 'prod' },
    });

    render(<ReportsPage />);

    await screen.findByText('Deployment Frequency');
    expect(screen.getByText(/Scoped to deployments · prod/)).toBeInTheDocument();
    // The run-basis indicator is not shown for a deploy-basis response.
    expect(screen.queryByText(/Counting pipeline runs/i)).not.toBeInTheDocument();
  });

  it('keeps the scope controls mounted and shows an empty state when the scope returns no DORA data', async () => {
    // Executions exist (fetched org-wide), so the overview renders; only the
    // scoped DORA payload comes back empty (getDora → undefined ⇒ null).
    getExecutionCount.mockResolvedValue({ data: { pipelines: [pipelineRow('p1', 'Pipe One')] } });
    getDora.mockResolvedValue(undefined);

    render(<ReportsPage />);

    // Bug 1: heading + scope controls stay mounted even with no dora, so the
    // user can still clear an over-narrow filter.
    expect(await screen.findByText('DORA Metrics')).toBeInTheDocument();
    expect(screen.getByLabelText(/filter dora by pipeline/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/filter dora by environment/i)).toBeInTheDocument();
    // Explicit empty state; the metric cards do NOT render.
    expect(screen.getByText(/No DORA data for this scope/i)).toBeInTheDocument();
    expect(screen.queryByText('Deployment Frequency')).not.toBeInTheDocument();
  });

  it('debounces the environment filter — typing does not fire a request per keystroke (commits on blur)', async () => {
    getExecutionCount.mockResolvedValue({ data: { pipelines: [pipelineRow('p1', 'Pipe One')] } });
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);
    await screen.findByText('DORA Metrics');

    getDora.mockClear();
    getDoraTrend.mockClear();
    const input = screen.getByLabelText(/filter dora by environment/i);
    // Each keystroke only updates the controlled input — no committed value
    // change, so no fetch fires synchronously.
    fireEvent.change(input, { target: { value: 'p' } });
    fireEvent.change(input, { target: { value: 'pr' } });
    fireEvent.change(input, { target: { value: 'pro' } });
    fireEvent.change(input, { target: { value: 'prod' } });
    expect(getDora).not.toHaveBeenCalled();

    // Blur commits the value → exactly one request with the final environment.
    fireEvent.blur(input, { target: { value: 'prod' } });
    await screen.findByText('DORA Metrics');
    expect(getDora).toHaveBeenCalledTimes(1);
    expect(getDora).toHaveBeenLastCalledWith(expect.objectContaining({ environment: 'prod' }));
    expect(getDoraTrend).toHaveBeenLastCalledWith(expect.objectContaining({ environment: 'prod' }));
  });
});

describe('DORA helpers (unit)', () => {
  it('fmtWindow returns "" for an invalid or missing window', () => {
    expect(fmtWindow({ from: 'not-a-date', to: 'also-not-a-date' })).toBe('');
    expect(fmtWindow(undefined)).toBe('');
  });

  it('doraLevelBadge returns null for an unrated (null) level', () => {
    expect(doraLevelBadge(null)).toBeNull();
  });
});
