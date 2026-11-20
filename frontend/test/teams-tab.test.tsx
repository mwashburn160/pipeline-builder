// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports → Teams: the upsell (no fetch without advanced_reporting), the
 * reports:rollup note (no fetch without it), the empty state for an org with no
 * teams, the sortable table with its band chips and `insufficient` cells, the
 * CSV, and that the read carries the org's reporting timezone + week start.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const mockBench = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPolicy = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.mock('@/lib/api', () => {
  const client = {
    getTeamBenchmark: (...a: unknown[]) => mockBench(...a),
    getReportPolicy: (...a: unknown[]) => mockPolicy(...a),
  };
  return { __esModule: true, default: client, api: client };
});

import { TeamsTab, TeamsTable, sortTeamRows, teamCsvRows } from '../src/components/reports/tabs/TeamsTab';
import type { TeamBenchmarkRow } from '../src/lib/api/domains/reporting-benchmark';

const row = (over: Partial<TeamBenchmarkRow> & { orgId: string }): TeamBenchmarkRow => ({
  name: null,
  role: 'team',
  state: 'ok',
  environment: 'production',
  deploymentFrequency: { value: { deployments: 10, perDay: 0.5 }, level: 'high', n: 10 },
  changeFailureRate: { value: { rate: 10, attempts: 10 }, level: 'elite', n: 10 },
  leadTime: { value: { medianSeconds: 3600 }, level: 'elite', n: 10 },
  timeToRestore: { value: { medianSeconds: 1800 }, level: 'elite', n: 6 },
  successRate: { pct: 90, runs: 20, succeeded: 18, failed: 2, canceled: 0 },
  ...over,
});

const ROWS: TeamBenchmarkRow[] = [
  row({ orgId: 'acme', name: 'Acme', role: 'parent', successRate: { pct: 50, runs: 2, succeeded: 1, failed: 1, canceled: 0 } }),
  row({ orgId: 't-pay', name: 'Payments', deploymentFrequency: { value: { deployments: 2, perDay: 0.1 }, level: 'insufficient', n: 2 } }),
  row({ orgId: 't-web', name: 'Web', deploymentFrequency: { value: { deployments: 30, perDay: 1.5 }, level: 'elite', n: 30 }, successRate: { pct: 99, runs: 100, succeeded: 99, failed: 1, canceled: 0 } }),
  row({ orgId: 't-ops', name: 'Ops', deploymentFrequency: null, changeFailureRate: null, leadTime: null, successRate: { pct: null, runs: 0, succeeded: 0, failed: 0, canceled: 0 } }),
];

const FILTERS = { dateFrom: '2026-10-01', dateTo: '2026-11-01', interval: 'week' as const, includeDescendants: false };

beforeEach(() => {
  jest.clearAllMocks();
  mockPolicy.mockResolvedValue({ data: { policy: { defaultTimezone: 'America/Chicago', defaultWeekStart: 'sunday' } } });
  mockBench.mockResolvedValue({ hasTeams: true, window: { dora: { from: '2026-10-01', to: '2026-11-01' }, events: { from: '2026-10-01', to: '2026-11-01' }, tz: 'America/Chicago', weekStart: 'sunday' }, rows: ROWS });
});

describe('sortTeamRows', () => {
  it('keeps the parent first and sorts the teams, blanks last in both directions', () => {
    const names = (rs: TeamBenchmarkRow[]) => rs.map((r) => r.name);
    expect(names(sortTeamRows(ROWS, 'deployFrequency', 'desc'))).toEqual(['Acme', 'Web', 'Payments', 'Ops']);
    expect(names(sortTeamRows(ROWS, 'deployFrequency', 'asc'))).toEqual(['Acme', 'Payments', 'Web', 'Ops']);
    expect(names(sortTeamRows(ROWS, 'successRate', 'asc'))).toEqual(['Acme', 'Payments', 'Web', 'Ops']);
    expect(names(sortTeamRows(ROWS, 'name', 'asc'))).toEqual(['Acme', 'Ops', 'Payments', 'Web']);
  });
});

describe('teamCsvRows', () => {
  it('flattens each team with its band and n', () => {
    const [, pay] = teamCsvRows(ROWS);
    expect(pay).toEqual(expect.objectContaining({
      team: 'Payments', org_id: 't-pay', deployments: 2, deploy_frequency_band: 'insufficient', deploy_frequency_n: 2, success_rate_pct: 90,
    }));
    // Team level only: nothing in the export names a person.
    expect(Object.keys(pay).filter((k) => /user|author|committer|person|member/.test(k))).toEqual([]);
  });
});

describe('TeamsTable', () => {
  it('renders band chips, the not-enough-data cell, and re-sorts on a header click', () => {
    render(<TeamsTable rows={ROWS} />);
    expect(screen.getByText('Not enough data (n = 2)')).toBeInTheDocument();
    expect(screen.getAllByText('Elite').length).toBeGreaterThan(0);
    expect(screen.getByText('(this organization)')).toBeInTheDocument();
    expect(screen.getByText('No deploys')).toBeInTheDocument();

    const header = screen.getByRole('button', { name: /deploy frequency/i });
    fireEvent.click(header);
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'descending');
    const bodyRows = screen.getAllByRole('row').slice(1);
    expect(bodyRows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['Acme(this organization)', 'Web', 'Payments', 'Ops']);
    fireEvent.click(header);
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'ascending');
  });

  it('isolates a failed team', () => {
    render(<TeamsTable rows={[row({ orgId: 'x', name: 'Broken', state: 'failed' })]} />);
    expect(screen.getByText(/could not load this team/i)).toBeInTheDocument();
  });
});

describe('TeamsTab', () => {
  it('shows the upsell and fetches nothing without advanced_reporting', async () => {
    render(<TeamsTab filters={FILTERS} enabled={false} canRollup onStatus={() => {}} />);
    expect(screen.getByText('Unlock Advanced Reporting')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockBench).not.toHaveBeenCalled();
  });

  it('explains the reports:rollup requirement and fetches nothing without it', async () => {
    render(<TeamsTab filters={FILTERS} enabled canRollup={false} onStatus={() => {}} />);
    expect(screen.getByText(/needs the reports:rollup permission/i)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockBench).not.toHaveBeenCalled();
  });

  it("reads the benchmark in the org's reporting timezone and week start and renders the table with CSV", async () => {
    render(<TeamsTab filters={FILTERS} enabled canRollup onStatus={() => {}} />);
    await waitFor(() => expect(screen.getByText('Payments')).toBeInTheDocument());
    expect(mockBench).toHaveBeenCalledWith(
      { from: '2026-10-01', to: '2026-11-01', interval: 'week', tz: 'America/Chicago', weekStart: 'sunday' },
      expect.anything(),
    );
    expect(screen.getByRole('button', { name: /csv/i })).toBeEnabled();
  });

  it('shows an empty state for an org without teams', async () => {
    mockBench.mockResolvedValue({ hasTeams: false, rows: [] });
    render(<TeamsTab filters={FILTERS} enabled canRollup onStatus={() => {}} />);
    await waitFor(() => expect(screen.getByText('No teams yet')).toBeInTheDocument());
  });
});
