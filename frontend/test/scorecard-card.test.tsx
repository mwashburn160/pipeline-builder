// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-pipeline maturity ScorecardCard: the `advanced_reporting`
 * gate (renders nothing when disabled), the grade-badge styling, and the DORA
 * band rendering incl. the `n/a` fallback for an unrated (null) level.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import { ScorecardCard } from '../src/components/pipeline/ScorecardCard';
import { GRADE_STYLES } from '../src/components/reports/DoraParts';
import type { PipelineScorecard } from '../src/types';

// Toggle the advanced_reporting entitlement per-test.
let mockEnabled = true;
let mockSuperAdmin = false;
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({
    isEnabled: (f: string) => (f === 'advanced_reporting' ? mockEnabled : true),
    isSuperAdmin: mockSuperAdmin,
    features: [],
    isLoaded: true,
    supportAlias: 'support@pipeline-builder',
  }),
}));

const getPipelineScorecard = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getPipelineScorecard: (...a: unknown[]) => getPipelineScorecard(...a),
  },
}));

const baseScorecard: PipelineScorecard = {
  pipelineId: 'p1',
  score: 82,
  grade: 'A',
  compliance: { score: 90, rulesEvaluated: 12, violations: 1, warnings: 2 },
  dora: {
    score: 74,
    basis: 'deploy',
    deploymentFrequency: 'elite',
    changeFailureRate: 'medium',
    meanTimeToRestore: null, // unrated → renders "n/a"
    leadTime: 'high',
  },
  security: {
    score: 60,
    exposures: { count: 2, critical: 1, high: 3, kev: 1 },
    artifact: { reports: 1, critical: 0, high: 2, kev: 0, latestAt: '2026-08-19T00:00:00.000Z' },
  },
  computedAt: '2026-08-20T00:00:00.000Z',
};

beforeEach(() => {
  mockEnabled = true;
  mockSuperAdmin = false;
  getPipelineScorecard.mockReset().mockResolvedValue({ success: true, data: { scorecard: baseScorecard } });
});

describe('ScorecardCard', () => {
  it('shows the plan lock (not a silent gap) when advanced_reporting is off', () => {
    mockEnabled = false;
    render(<ScorecardCard pipelineId="p1" />);
    expect(screen.getByTestId('feature-lock-advanced_reporting')).toBeInTheDocument();
    // Gated: the scorecard is never fetched.
    expect(getPipelineScorecard).not.toHaveBeenCalled();
  });

  it('lets a superadmin through without the entitlement (useFeatureGate bypass)', async () => {
    mockEnabled = false;
    mockSuperAdmin = true;
    render(<ScorecardCard pipelineId="p1" />);
    await waitFor(() => expect(getPipelineScorecard).toHaveBeenCalledWith('p1', expect.objectContaining({ signal: expect.anything() })));
    expect(screen.queryByTestId('feature-lock-advanced_reporting')).not.toBeInTheDocument();
  });

  it('renders the graded scorecard with the grade badge styled by grade', async () => {
    render(<ScorecardCard pipelineId="p1" />);
    const grade = await screen.findByText('A');
    // The badge is styled BY GRADE. Asserted against the component's own
    // GRADE_STYLES map rather than a hard-coded palette token, so re-theming the
    // badge can't fail this test while the grade→style wiring is still correct —
    // and rendering grade A with, say, grade F's style still does.
    expect(grade).toHaveClass(...GRADE_STYLES.A.split(' '));
    expect(grade).not.toHaveClass(...GRADE_STYLES.F.split(' '));
    expect(screen.getByText('Maturity scorecard')).toBeInTheDocument();
  });

  it('renders DORA bands and shows "n/a" for an unrated (null) level', async () => {
    render(<ScorecardCard pipelineId="p1" />);
    await screen.findByText('A');
    // Rated bands surface their labels; MTTR (null) falls back to "n/a".
    expect(screen.getByText('Elite')).toBeInTheDocument();
    expect(screen.getByText('Time to restore')).toBeInTheDocument();
    expect(screen.getByText('n/a')).toBeInTheDocument();
  });

  it('shows a "not enough data yet" empty state for an ungraded (N/A + null score) scorecard', async () => {
    getPipelineScorecard.mockResolvedValue({
      success: true,
      data: {
        scorecard: {
          ...baseScorecard,
          score: null,
          grade: 'N/A',
          compliance: { score: null, rulesEvaluated: 0, violations: 0, warnings: 0 },
          dora: { score: null, basis: 'deploy', deploymentFrequency: null, changeFailureRate: null, meanTimeToRestore: null, leadTime: null },
        },
      },
    });
    render(<ScorecardCard pipelineId="p1" />);
    expect(await screen.findByText('Not enough data yet')).toBeInTheDocument();
    // The dead N/A grid (band labels) must NOT render in the empty state.
    expect(screen.queryByText('Deploy frequency')).not.toBeInTheDocument();
  });

  it('does not blame missing data when the SERVER could not compute the card', async () => {
    // `unavailable` arrives looking exactly like the empty state — null score,
    // N/A grade — so before this flag was carried, a failed computation rendered
    // "Not enough data yet" and told the reader to run `setup-events --with-dora`
    // in answer to a server-side error.
    getPipelineScorecard.mockResolvedValue({
      success: true,
      data: {
        scorecard: {
          ...baseScorecard,
          score: null,
          grade: 'N/A',
          unavailable: true,
          compliance: { score: null, rulesEvaluated: 0, violations: 0, warnings: 0 },
          dora: { score: null, basis: 'deploy', deploymentFrequency: null, changeFailureRate: null, meanTimeToRestore: null, leadTime: null },
        },
      },
    });
    render(<ScorecardCard pipelineId="p1" />);
    expect(await screen.findByText(/Scorecard unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('Not enough data yet')).not.toBeInTheDocument();
    expect(screen.queryByText(/setup-events/)).not.toBeInTheDocument();
  });

  it('shows an unavailable message when the scorecard fetch fails', async () => {
    getPipelineScorecard.mockResolvedValue({ success: false });
    render(<ScorecardCard pipelineId="p1" />);
    await waitFor(() => expect(getPipelineScorecard).toHaveBeenCalled());
    expect(await screen.findByText(/Scorecard unavailable/i)).toBeInTheDocument();
  });
  it('shows the security dimension: score, open exposures, artifact findings and KEV', async () => {
    render(<ScorecardCard pipelineId="p1" />);
    const row = await screen.findByTestId('scorecard-security');
    expect(row).toHaveTextContent('2 open plugin exposures');
    expect(row).toHaveTextContent('0 crit · 2 high in 1 artifact report');
    expect(row).toHaveTextContent('1 KEV');
    expect(screen.getByText(/security 60/)).toBeInTheDocument();
  });
});
