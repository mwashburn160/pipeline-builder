// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Render test for the DORA metrics section on the reports page: asserts the 4
 * cards, the measured/"unknown" lead time, the CFR breakdown, MTTR humanization,
 * the null → "—" fallback, the performance-level badge, the reporting-window
 * line, the coverage note, and the `advanced_reporting` feature gate.
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
    can: () => false,
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
const listPipelineExecutions = jest.fn();
const getBuildHealth = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getExecutionCount: (...a: unknown[]) => getExecutionCount(...a),
    getSuccessRate: jest.fn().mockResolvedValue({ data: { timeline: [] } }),
    getDora: (...a: unknown[]) => getDora(...a),
    getDoraTrend: (...a: unknown[]) => getDoraTrend(...a),
    listPipelines: (...a: unknown[]) => listPipelines(...a),
    getReportEnvironments: (...a: unknown[]) => getReportEnvironments(...a),
    listPipelineExecutions: (...a: unknown[]) => listPipelineExecutions(...a),
    getBuildHealth: (...a: unknown[]) => getBuildHealth(...a),
    markDeploymentOutcome: jest.fn().mockResolvedValue({ success: true }),
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
  filters: { pipelineId: null, environment: null },
  headline: 'production',
  environments: [
    {
      environment: 'production',
      deploymentFrequency: { deployments: 8, perDay: 0.27 },
      leadTime: { deployments: 8, medianSeconds: 330, level: 'elite' },
      changeFailureRate: { rate: 25, deployTimeFailures: 1, postDeployFailures: 1, attempts: 8, level: 'medium' },
    },
    {
      environment: 'staging',
      deploymentFrequency: { deployments: 12, perDay: 0.4 },
      leadTime: { deployments: 12, medianSeconds: 120, level: 'high' },
      changeFailureRate: { rate: 8, deployTimeFailures: 1, postDeployFailures: 0, attempts: 12, level: 'elite' },
    },
  ],
  meanTimeToRestore: { medianSeconds: 3720, incidents: 2, restored: 2 },
  coverage: { registered: 5, deploying: 3, withoutDeploys: 2 },
};

beforeEach(() => {
  mockDoraEnabled = true;
  getDora.mockReset();
  getDoraTrend.mockReset().mockResolvedValue([]);
  getExecutionCount.mockReset().mockResolvedValue({ data: { pipelines: [] } });
  listPipelines.mockReset().mockResolvedValue({ data: { pipelines: [] } });
  getReportEnvironments.mockReset().mockResolvedValue({ data: { environments: [] } });
  listPipelineExecutions.mockReset().mockResolvedValue({ data: { executions: [] } });
  getBuildHealth.mockReset().mockResolvedValue({ stages: [], totals: { runs: 0, failures: 0, failureRate: 0 } });
});

/** DORA now lives on its own feature-gated top tab (not the pipelines/overview
 *  view). Click it to mount the DORA panel + trigger its fetches. */
const goToDora = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /^dora$/i }));
};

describe('ReportsPage — DORA section', () => {
  it('renders the 4 DORA cards with humanized MTTR + measured lead time and the CFR breakdown', async () => {
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);
    await goToDora();

    expect(await screen.findByText('Deployment Frequency')).toBeInTheDocument();
    expect(screen.getByText('Change Failure Rate')).toBeInTheDocument();
    expect(screen.getByText('Time to Restore (MTTR)')).toBeInTheDocument();
    // Lead time is measured (no proxy/approximation copy).
    expect(screen.getAllByText(/Lead time/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/median commit/i)).toBeInTheDocument();

    expect(screen.getByText('25%')).toBeInTheDocument();
    // CFR sub: combined failures / attempts, plus the deploy-time/post-deploy split.
    expect(screen.getByText('2/8 deploys failed')).toBeInTheDocument();
    expect(screen.getByText(/1 deploy-time/)).toBeInTheDocument();
    // MTTR humanization: 3720s → "1h 2m".
    expect(screen.getByText('1h 2m')).toBeInTheDocument();
    // Lead time humanization: 330s → "5m 30s".
    expect(screen.getByText('5m 30s')).toBeInTheDocument();
    // Coverage reconciliation note.
    expect(screen.getByText(/5 registered pipelines/)).toBeInTheDocument();
  });

  it('renders performance-level badges from the headline environment lead time + CFR', async () => {
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);
    await goToDora();

    await screen.findByText('Deployment Frequency');
    // The headline (production) lead-time (elite) + CFR (medium) bands surface as
    // pills. Deployment frequency + MTTR carry no level band in the new shape.
    expect(screen.getByText('Elite')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
  });

  it('surfaces the reporting window and the deployment-scoped indicator', async () => {
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);
    await goToDora();

    await screen.findByText('Deployment Frequency');
    // Window renders as "Jun … – Jul …, 2026" (locale/TZ-formatted — assert the
    // year-bearing end of the range to stay timezone-robust in CI).
    expect(screen.getByText(/–\s*Jul \d{1,2}, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Deployment-scoped/i)).toBeInTheDocument();
  });

  it('shows "—" for MTTR and "unknown" for lead time when unresolvable (none restored)', async () => {
    getDora.mockResolvedValue({
      ...baseDora,
      environments: [
        {
          environment: 'production',
          deploymentFrequency: { deployments: 3, perDay: 0.1 },
          leadTime: { deployments: 3, medianSeconds: null, level: null },
          changeFailureRate: { rate: 0, deployTimeFailures: 0, postDeployFailures: 0, attempts: 3, level: null },
        },
      ],
      meanTimeToRestore: { medianSeconds: null, incidents: 0, restored: 0 },
    });

    render(<ReportsPage />);
    await goToDora();

    expect(await screen.findByText('Time to Restore (MTTR)')).toBeInTheDocument();
    expect(screen.getByText('0/0 incidents restored')).toBeInTheDocument();
    // MTTR falls back to the em dash; lead time is explicitly "unknown" (no proxy).
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('renders the DORA upsell (not the metrics) on the DORA tab when advanced_reporting is disabled', async () => {
    mockDoraEnabled = false;
    getExecutionCount.mockResolvedValue({ data: { pipelines: [pipelineRow('p1', 'Pipe One')] } });
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);

    // The DORA tab is ALWAYS present now; non-entitled users land on the upsell
    // teaser instead of a hidden tab / dead-end.
    await goToDora();
    expect(await screen.findByRole('link', { name: /unlock advanced reporting/i })).toBeInTheDocument();
    // No metric fetch fires for the non-entitled teaser.
    expect(getDora).not.toHaveBeenCalled();
    expect(getDoraTrend).not.toHaveBeenCalled();
  });

  it('shows a DORA tab that mounts the section + fires the fetches when entitled', async () => {
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);
    // The tab exists when entitled; DORA doesn't fetch until it's opened.
    expect(await screen.findByRole('button', { name: /^dora$/i })).toBeInTheDocument();
    expect(getDora).not.toHaveBeenCalled();

    await goToDora();

    expect(await screen.findByText('DORA Metrics')).toBeInTheDocument();
    expect(getDora).toHaveBeenCalled();
    expect(getDoraTrend).toHaveBeenCalled();
  });

  it('forwards pipelineId to getDora + getDoraTrend when a pipeline is picked', async () => {
    getExecutionCount.mockResolvedValue({ data: { pipelines: [pipelineRow('p1', 'Pipe One')] } });
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);
    await goToDora();
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
    await goToDora();
    await screen.findByText('DORA Metrics');

    const picker = screen.getByLabelText(/filter dora by pipeline/i) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toContain('Never Run');
  });

  it('renders the deployment-trend sparkline (bars, sr-only table, role="img" summary) when trend points exist', async () => {
    getDora.mockResolvedValue(baseDora);
    getDoraTrend.mockResolvedValue([
      { period: '2026-07-01T00:00:00.000Z', deployments: 3, failed: 1, total: 3 },
      { period: '2026-07-08T00:00:00.000Z', deployments: 5, failed: 0, total: 5 },
    ]);

    render(<ReportsPage />);
    await goToDora();

    // Section heading + the role="img" summary conveyed to assistive tech.
    await screen.findByText('Deployment Trend');
    const chart = screen.getByRole('img', { name: /deployment trend over 2 periods/i });
    expect(chart).toBeInTheDocument();
    // The visually-hidden per-period data table mirrors the bars.
    expect(screen.getByText('Deployments and change-failure rate per period')).toBeInTheDocument();
    // The 33% bucket is tagged as elevated in the sr-only table.
    expect(screen.getByText('Elevated change-failure')).toBeInTheDocument();
  });

  it('renders a clickable env pill per environment and pivots the headline on click', async () => {
    getDora.mockResolvedValue(baseDora);

    render(<ReportsPage />);
    await goToDora();
    await screen.findByText('Deployment Frequency');

    // Both environments surface as pivot pills (production headline + staging).
    expect(screen.getByTitle(/Pivot the headline to production/i)).toBeInTheDocument();
    const stagingPill = screen.getByTitle(/Pivot the headline to staging/i);
    expect(stagingPill).toBeInTheDocument();

    getDora.mockClear();
    fireEvent.click(stagingPill);
    // Clicking a pill commits the env → the DORA fetch re-scopes to it.
    await screen.findByText('Deployment Frequency');
    expect(getDora).toHaveBeenLastCalledWith(expect.objectContaining({ environment: 'staging' }));
  });

  it('shows the deployment-scoped indicator with the active environment filter', async () => {
    getDora.mockResolvedValue({
      ...baseDora,
      filters: { pipelineId: null, environment: 'prod' },
    });

    render(<ReportsPage />);
    await goToDora();

    await screen.findByText('Deployment Frequency');
    expect(screen.getByText(/Deployment-scoped · prod/)).toBeInTheDocument();
  });

  it('keeps the scope controls mounted and shows an empty state when the scope returns no DORA data', async () => {
    // Executions exist (fetched org-wide), so the overview renders; only the
    // scoped DORA payload comes back empty (getDora → undefined ⇒ null).
    getExecutionCount.mockResolvedValue({ data: { pipelines: [pipelineRow('p1', 'Pipe One')] } });
    getDora.mockResolvedValue(undefined);

    render(<ReportsPage />);
    await goToDora();

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
    await goToDora();
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
