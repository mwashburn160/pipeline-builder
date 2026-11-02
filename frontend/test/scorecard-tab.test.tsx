// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the org-wide ScorecardTab (software-health leaderboard): the
 * advanced_reporting gate, the ranked leaderboard rows, and the aggregate summary.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import { ScorecardTab } from '../src/components/reports/tabs/ScorecardTab';
import type { ScorecardRollup } from '../src/types';

const getOrgScorecardRollup = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOrgScorecardRollup: (...a: unknown[]) => getOrgScorecardRollup(...a),
  },
}));

const band = (level: 'elite' | 'high' | 'medium' | 'low' | null) => level;
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
      dora: { score: 80, basis: 'deploy', deploymentFrequency: band('elite'), changeFailureRate: band('high'), meanTimeToRestore: band(null), leadTime: band('high') },
      security: { score: 77, exposures: { count: 1, critical: 0, high: 1, kev: 1 }, artifact: null },
      computedAt: '2026-08-20T00:00:00.000Z',
    },
    {
      pipelineId: 'p2', name: 'Bravo', score: 54, grade: 'C',
      compliance: { score: 60, rulesEvaluated: 8, violations: 2, warnings: 0 },
      dora: { score: 48, basis: 'deploy', deploymentFrequency: band('low'), changeFailureRate: band('medium'), meanTimeToRestore: band('low'), leadTime: band('medium') },
      security: { score: null, exposures: { count: 0, critical: 0, high: 0, kev: 0 }, artifact: null },
      computedAt: '2026-08-20T00:00:00.000Z',
    },
  ],
  computedAt: '2026-08-20T00:00:00.000Z',
  truncated: false,
};

beforeEach(() => {
  getOrgScorecardRollup.mockReset().mockResolvedValue({ success: true, data: { rollup } });
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
  });

  it('does NOT fetch and shows an upsell when advanced_reporting is disabled', async () => {
    render(<ScorecardTab enabled={false} onStatus={jest.fn<AnyFn>()} />);
    expect(screen.getByText(/requires the/i)).toBeInTheDocument();
    expect(getOrgScorecardRollup).not.toHaveBeenCalled();
  });
});
