// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-pipeline maturity ScorecardCard: the `advanced_reporting`
 * gate (renders nothing when disabled), the grade-badge styling, and the DORA
 * band rendering incl. the `n/a` fallback for an unrated (null) level.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { ScorecardCard } from '../src/components/pipeline/ScorecardCard';
import type { PipelineScorecard } from '../src/types';

// Toggle the advanced_reporting entitlement per-test.
let mockEnabled = true;
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({
    isEnabled: (f: string) => (f === 'advanced_reporting' ? mockEnabled : true),
    features: [],
    isLoaded: true,
    supportAlias: 'support@pipeline-builder',
  }),
}));

const getPipelineScorecard = jest.fn();
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
  computedAt: '2026-08-20T00:00:00.000Z',
};

beforeEach(() => {
  mockEnabled = true;
  getPipelineScorecard.mockReset().mockResolvedValue({ success: true, data: { scorecard: baseScorecard } });
});

describe('ScorecardCard', () => {
  it('renders nothing (null) when advanced_reporting is disabled', () => {
    mockEnabled = false;
    const { container } = render(<ScorecardCard pipelineId="p1" />);
    expect(container).toBeEmptyDOMElement();
    // Gated: the scorecard is never fetched.
    expect(getPipelineScorecard).not.toHaveBeenCalled();
  });

  it('renders the graded scorecard with the grade badge styled by grade', async () => {
    render(<ScorecardCard pipelineId="p1" />);
    const grade = await screen.findByText('A');
    // Grade "A" carries the green grade-style classes (GRADE_STYLES['A']).
    expect(grade).toHaveClass('bg-green-100');
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

  it('shows an unavailable message when the scorecard fetch fails', async () => {
    getPipelineScorecard.mockResolvedValue({ success: false });
    render(<ScorecardCard pipelineId="p1" />);
    await waitFor(() => expect(getPipelineScorecard).toHaveBeenCalled());
    expect(await screen.findByText(/Scorecard unavailable/i)).toBeInTheDocument();
  });
});
