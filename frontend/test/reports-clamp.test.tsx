// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports page — per-tab date-range clamp + consolidated empty states.
 *
 * The frontend must NEVER issue an over-range request: a preset (or custom range)
 * wider than the active tab's retention cap is clamped to the cap and a subtle
 * inline note is shown instead of the old hostile red error. Pipelines/Plugins cap
 * at event retention (30d default), DORA at dora retention (180d default).
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReportsPage from '../pages/dashboard/reports';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

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
const getDora = jest.fn();
const getReportRetention = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getExecutionCount: (...a: unknown[]) => getExecutionCount(...a),
    getSuccessRate: (...a: unknown[]) => getSuccessRate(...a),
    getDora: (...a: unknown[]) => getDora(...a),
    getDoraTrend: jest.fn().mockResolvedValue([]),
    getReportRetention: (...a: unknown[]) => getReportRetention(...a),
    listPipelines: jest.fn().mockResolvedValue({ data: { pipelines: [] } }),
    getReportEnvironments: jest.fn().mockResolvedValue({ data: { environments: [] } }),
  },
}));

/** Whole days spanned by a captured getExecutionCount call's from/to. */
function callSpanDays(arg: { from?: string; to?: string } | undefined): number | null {
  if (!arg?.from || !arg?.to) return null;
  return Math.round((new Date(arg.to).getTime() - new Date(arg.from).getTime()) / 86_400_000);
}

beforeEach(() => {
  getExecutionCount.mockReset().mockResolvedValue({ data: { pipelines: [] } });
  getSuccessRate.mockReset().mockResolvedValue({ data: { timeline: [] } });
  getDora.mockReset().mockResolvedValue(null);
  getReportRetention.mockReset().mockResolvedValue({
    eventRetentionDays: 30, doraRetentionDays: 180, eventMaxRangeDays: 30, doraMaxRangeDays: 180,
  });
});

describe('ReportsPage — per-tab date-range clamp', () => {
  it('clamps a preset wider than the pipelines cap and shows the note (no over-range request)', async () => {
    render(<ReportsPage />);
    // Initial fetch fires with no from/to (backend default window).
    await waitFor(() => expect(getExecutionCount).toHaveBeenCalled());

    getExecutionCount.mockClear();
    // "Last 180d" exceeds the 30-day event-retention cap → must clamp to 30.
    fireEvent.click(screen.getByRole('button', { name: 'Last 180d' }));

    await waitFor(() => expect(getExecutionCount).toHaveBeenCalled());
    // The request that actually went out spans at most the 30-day cap — never 180.
    const spans = getExecutionCount.mock.calls
      .map((c) => callSpanDays(c[0] as { from?: string; to?: string }))
      .filter((n): n is number => n != null);
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) expect(s).toBeLessThanOrEqual(30);

    // A subtle inline note (not a red error / Retry dead-end) explains the clamp.
    expect(await screen.findByText(/maximum for pipeline reports/i)).toBeInTheDocument();
    expect(screen.getByText(/Showing the last 30 days/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('does not clamp or note a preset within the cap', async () => {
    render(<ReportsPage />);
    await waitFor(() => expect(getExecutionCount).toHaveBeenCalled());

    getExecutionCount.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Last 7d' }));

    await waitFor(() => expect(getExecutionCount).toHaveBeenCalled());
    const spans = getExecutionCount.mock.calls
      .map((c) => callSpanDays(c[0] as { from?: string; to?: string }))
      .filter((n): n is number => n != null);
    expect(spans.every((s) => s <= 7)).toBe(true);
    expect(screen.queryByText(/maximum for pipeline reports/i)).not.toBeInTheDocument();
  });

  it('allows a 180d window on the DORA tab (its cap is 180) without a clamp note', async () => {
    render(<ReportsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^dora$/i }));
    await waitFor(() => expect(getDora).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Last 180d' }));
    await waitFor(() => {
      const last = getDora.mock.calls.at(-1)?.[0] as { from?: string; to?: string } | undefined;
      expect(last?.from).toBeTruthy();
    });
    // 180d is within the DORA cap → no clamp note.
    expect(screen.queryByText(/maximum for DORA reports/i)).not.toBeInTheDocument();
  });
});

describe('ReportsPage — consolidated empty state per tab', () => {
  it('shows ONE consolidated empty state (with a next-step hint) on an empty DORA tab', async () => {
    getExecutionCount.mockResolvedValue({ data: { pipelines: [] } });
    getDora.mockResolvedValue(null);

    render(<ReportsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^dora$/i }));

    // Single empty state with the DORA setup hint...
    expect(await screen.findByRole('heading', { name: /No deploy data yet/i })).toBeInTheDocument();
    expect(screen.getByText(/setup-events --with-dora/i)).toBeInTheDocument();
    // ...and NOT the four stacked panel empties / metric cards.
    expect(screen.queryByText('Deployment frequency')).not.toBeInTheDocument();
    expect(screen.queryByText(/No deploy-attributed environments/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Select a pipeline/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No stage activity/i)).not.toBeInTheDocument();
  });

  it('shows the pipelines consolidated empty state with the "no executions" hint', async () => {
    getExecutionCount.mockResolvedValue({ data: { pipelines: [] } });
    getSuccessRate.mockResolvedValue({ data: { timeline: [] } });

    render(<ReportsPage />);
    expect(await screen.findByText('No pipeline data yet')).toBeInTheDocument();
    expect(screen.getByText(/No executions in this window/i)).toBeInTheDocument();
  });
});

describe('ReportsPage — effective retention (GET /reports/retention)', () => {
  it('widens the pipelines cap to a Retention Pack horizon and links "Extend retention" to retention_pack past it', async () => {
    getReportRetention.mockResolvedValue({
      eventRetentionDays: 120, doraRetentionDays: 180, eventMaxRangeDays: 120, doraMaxRangeDays: 180,
    });
    render(<ReportsPage />);
    await waitFor(() => expect(getReportRetention).toHaveBeenCalled());
    await waitFor(() => expect(getExecutionCount).toHaveBeenCalled());

    // 90d is inside the purchased 120-day horizon — no clamp, no warning.
    getExecutionCount.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Last 90d' }));
    await waitFor(() => expect(getExecutionCount).toHaveBeenCalled());
    expect(screen.queryByText(/maximum for pipeline reports/i)).not.toBeInTheDocument();

    // 180d exceeds it — clamped to 120 with a buy-more link to the Retention Pack.
    fireEvent.click(screen.getByRole('button', { name: 'Last 180d' }));
    expect(await screen.findByText(/Showing the last 120 days/i)).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /extend retention/i });
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l).toHaveAttribute('href', '/dashboard/billing?highlight=retention_pack');
  });

  it('links the DORA tab past its horizon to the DORA-History pack', async () => {
    render(<ReportsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^dora$/i }));
    await waitFor(() => expect(getDora).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Last 365d' }));
    expect(await screen.findByText(/maximum for DORA reports/i)).toBeInTheDocument();
    for (const l of screen.getAllByRole('link', { name: /extend retention/i })) {
      expect(l).toHaveAttribute('href', '/dashboard/billing?highlight=dora_history_pack');
    }
  });

  it('offers no "Extend retention" link when retention is unlimited (the 730-day ceiling is fixed)', async () => {
    getReportRetention.mockResolvedValue({
      eventRetentionDays: -1, doraRetentionDays: -1, eventMaxRangeDays: 730, doraMaxRangeDays: 730,
    });
    render(<ReportsPage />);
    await waitFor(() => expect(getReportRetention).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Last 365d' }));
    await waitFor(() => expect(getExecutionCount).toHaveBeenCalled());
    expect(screen.queryByText(/maximum for pipeline reports/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /extend retention/i })).not.toBeInTheDocument();
  });
});
