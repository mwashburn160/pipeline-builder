// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the org-wide ScorecardTab (software-health leaderboard): the
 * advanced_reporting gate, the ranked leaderboard rows, and the aggregate summary.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { ScorecardTab } from '../src/components/reports/tabs/ScorecardTab';
import type { OrgScorecardHistory, ScorecardRollup } from '../src/types';

const getOrgScorecardRollup = jest.fn<AnyFn>();
const getOrgScorecardHistory = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOrgScorecardRollup: (...a: unknown[]) => getOrgScorecardRollup(...a),
    getOrgScorecardHistory: (...a: unknown[]) => getOrgScorecardHistory(...a),
    getReportPolicy: async () => ({ success: true, data: { policy: { defaultTimezone: 'UTC' } } }),
  },
}));

const band = (level: 'elite' | 'high' | 'medium' | 'low' | 'insufficient' | null) => level;
const samples = (n: number) => ({ deploymentFrequency: n, changeFailureRate: n, meanTimeToRestore: n, leadTime: n });
const rollup: ScorecardRollup = {
  orgId: 'org-1',
  pipelineCount: 2,
  scored: 2,
  averageScore: 71,
  gradeDistribution: { A: 1, C: 1 },
  leaderboard: [
    {
      pipelineId: 'p1', name: 'Alpha', score: 88, grade: 'A',
      compliance: { score: 95, rulesEvaluated: 10, violations: 0, warnings: 1 },
      dora: { score: 80, basis: 'deploy', deploymentFrequency: band('elite'), changeFailureRate: band('high'), meanTimeToRestore: band('insufficient'), leadTime: band('high'), samples: { ...samples(10), meanTimeToRestore: 2 } },
      security: { score: 77, exposures: { count: 1, critical: 0, high: 1, kev: 1 }, artifact: null },
      computedAt: '2026-08-20T00:00:00.000Z',
    },
    {
      pipelineId: 'p2', name: 'Bravo', score: 54, grade: 'C',
      compliance: { score: 60, rulesEvaluated: 8, violations: 2, warnings: 0 },
      dora: { score: 48, basis: 'deploy', deploymentFrequency: band('low'), changeFailureRate: band('medium'), meanTimeToRestore: band('low'), leadTime: band('medium'), samples: samples(8) },
      security: { score: null, exposures: { count: 0, critical: 0, high: 0, kev: 0 }, artifact: null },
      computedAt: '2026-08-20T00:00:00.000Z',
    },
  ],
  computedAt: '2026-08-20T00:00:00.000Z',
  truncated: false,
  pagination: { offset: 0, limit: 50, total: 2, hasMore: false, nextOffset: null },
};

const win = (label: string, averageScore: number | null, grade: string, partial = false) => ({
  label, from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z', partial, truncated: false, averageScore, grade, scored: 2,
});
const pt = (label: string, score: number | null, grade: string) => ({
  label, from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z', partial: false, truncated: false, score, grade,
});
const orgHistory = {
  orgId: 'org-1', interval: 'week', tz: 'UTC', weekStart: 'monday', computedAt: '2026-11-20T00:00:00Z',
  pagination: { offset: 0, limit: 50, total: 2, hasMore: false, nextOffset: null },
  windows: [win('2026-W46', 64, 'C'), win('2026-W47', 71, 'C', true)],
  pipelines: [
    { pipelineId: 'p1', name: 'Alpha', points: [pt('2026-W46', 79, 'B'), pt('2026-W47', 88, 'A')] },
    { pipelineId: 'p2', name: 'Bravo', points: [pt('2026-W46', 49, 'D'), pt('2026-W47', 54, 'D')] },
  ],
} as unknown as OrgScorecardHistory;

beforeEach(() => {
  getOrgScorecardRollup.mockReset().mockResolvedValue({ success: true, data: { rollup } });
  getOrgScorecardHistory.mockReset().mockResolvedValue({ success: true, data: { history: orgHistory } });
});

describe('ScorecardTab', () => {
  it('renders the ranked leaderboard + aggregate summary when entitled', async () => {
    render(<ScorecardTab enabled onStatus={jest.fn<AnyFn>()} />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    expect(screen.getByText('Bravo')).toBeInTheDocument();
    // Aggregate average score is shown.
    expect(screen.getByText('71')).toBeInTheDocument();
    // Grade-distribution chips — one per present grade (A ×1, C ×1).
    expect(screen.getAllByText(/×1/)).toHaveLength(2);
    // The security dimension has its own column (with a KEV marker).
    expect(screen.getByRole('columnheader', { name: 'Security' })).toBeInTheDocument();
    expect(screen.getByText('77')).toBeInTheDocument();
    expect(screen.getByText('KEV')).toBeInTheDocument();
    // Individual pipeline scores appear in the leaderboard.
    expect(screen.getByText('88')).toBeInTheDocument();
    expect(screen.getByText('54')).toBeInTheDocument();
    // An insufficient band is labelled with its sample, not rated.
    expect(screen.getByText('Not enough data (n = 2)')).toBeInTheDocument();
  });

  it('does NOT fetch and shows an upsell when advanced_reporting is disabled', async () => {
    render(<ScorecardTab enabled={false} onStatus={jest.fn<AnyFn>()} />);
    expect(screen.getByText(/requires the/i)).toBeInTheDocument();
    expect(getOrgScorecardRollup).not.toHaveBeenCalled();
  });

  it('a single page shows no pager and no page note; the first read sends offset 0 and no filter', async () => {
    render(<ScorecardTab enabled onStatus={jest.fn<AnyFn>()} />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    expect(getOrgScorecardRollup).toHaveBeenCalledWith({ offset: 0 });
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.queryByText(/stats cover this page/)).toBeNull();
  });

  it('pages with nextOffset and back, saying the stats cover this page', async () => {
    getOrgScorecardRollup.mockImplementation(async (q: unknown) => {
      const { offset } = q as { offset: number };
      return {
        success: true,
        data: {
          rollup: {
            ...rollup,
            truncated: offset === 0,
            pagination: offset === 0
              ? { offset: 0, limit: 2, total: 3, hasMore: true, nextOffset: 2 }
              : { offset: 2, limit: 2, hasMore: false, nextOffset: null },
          },
        },
      };
    });
    render(<ScorecardTab enabled onStatus={jest.fn<AnyFn>()} />);
    await waitFor(() => expect(screen.getByText(/stats cover this page \(pipelines 1–2 of 3\)/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(getOrgScorecardRollup).toHaveBeenLastCalledWith({ offset: 2 }));
    // No `total` on this page → the range is shown without "of N".
    await waitFor(() => expect(screen.getByText(/stats cover this page \(pipelines 3–4\)/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(getOrgScorecardRollup).toHaveBeenLastCalledWith({ offset: 0 }));
  });

  it('applies a trimmed project / name filter from offset 0, says when nothing matches, and clears it', async () => {
    getOrgScorecardRollup.mockImplementation(async (q: unknown) => {
      const { project } = q as { project?: string };
      return project
        ? { success: true, data: { rollup: { ...rollup, pipelineCount: 0, scored: 0, leaderboard: [], gradeDistribution: {}, averageScore: null, pagination: { offset: 0, limit: 50, total: 0, hasMore: false, nextOffset: null } } } }
        : { success: true, data: { rollup } };
    });
    render(<ScorecardTab enabled onStatus={jest.fn<AnyFn>()} />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '  web  ' } });
    fireEvent.change(screen.getByLabelText('Pipeline name'), { target: { value: 'api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(getOrgScorecardRollup).toHaveBeenLastCalledWith({ offset: 0, project: 'web', pipelineName: 'api' }));
    await waitFor(() => expect(screen.getByText('No pipelines match')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(getOrgScorecardRollup).toHaveBeenLastCalledWith({ offset: 0 }));
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('an empty org without a filter says there is nothing to score', async () => {
    getOrgScorecardRollup.mockResolvedValue({ success: true, data: { rollup: { ...rollup, pipelineCount: 0, leaderboard: [] } } });
    render(<ScorecardTab enabled onStatus={jest.fn<AnyFn>()} />);
    await waitFor(() => expect(screen.getByText('No pipelines to score yet')).toBeInTheDocument());
  });

  it('draws the org grade history and a strip per leaderboard row, from ONE history read for this page', async () => {
    render(<ScorecardTab enabled onStatus={jest.fn<AnyFn>()} />);
    const org = await screen.findByRole('list', { name: /org grade history/i });
    expect(within(org).getAllByRole('listitem').map((c) => c.getAttribute('aria-label')))
      .toEqual(['2026-W46: grade C, score 64', '2026-W47 (so far): grade C, score 71']);
    const alpha = screen.getByRole('list', { name: /grade history for Alpha/i });
    expect(within(alpha).getAllByRole('listitem')[1]).toHaveAccessibleName('2026-W47: grade A, score 88');
    expect(screen.getByRole('list', { name: /grade history for Bravo/i })).toBeInTheDocument();
    expect(getOrgScorecardHistory).toHaveBeenCalledTimes(1);
    expect(getOrgScorecardHistory).toHaveBeenCalledWith({ offset: 0, interval: 'week', periods: 12, tz: 'UTC' });
  });

  it('a failed history read still renders the leaderboard, without strips', async () => {
    getOrgScorecardHistory.mockResolvedValue({ success: false });
    render(<ScorecardTab enabled onStatus={jest.fn<AnyFn>()} />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    await waitFor(() => expect(getOrgScorecardHistory).toHaveBeenCalled());
    expect(screen.queryByRole('list', { name: /grade history/i })).toBeNull();
  });

  it('does not read history without the entitlement', () => {
    render(<ScorecardTab enabled={false} onStatus={jest.fn<AnyFn>()} />);
    expect(getOrgScorecardHistory).not.toHaveBeenCalled();
  });
});
