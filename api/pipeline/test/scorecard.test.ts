// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import {
  complianceScore,
  doraScoreFromMetrics,
  combineScore,
  gradeForScore,
  buildScorecard,
  securityScore,
  scorecardWindows,
  averageScore,
  SCORECARD_HISTORY_MAX_PERIODS,
} from '../src/helpers/scorecard.js';

type Level = 'elite' | 'high' | 'medium' | 'low' | 'insufficient' | null;

/** Minimal DoraMetrics (per-environment shape). Every per-env band — deployment
 *  frequency INCLUDED — now carries its own `level` in the response, and the
 *  scorecard consumes it directly (no re-derivation from `perDay`). */
function dora(levels: [Level, Level, Level, Level]): any {
  const [df, cfr, mttr, lt] = levels;
  return {
    window: { from: '', to: '' },
    filters: { pipelineId: null, environment: null },
    headline: 'production',
    environments: [{
      environment: 'production',
      deploymentFrequency: { deployments: 0, perDay: 0, level: df },
      leadTime: { deployments: 0, medianSeconds: null, level: lt },
      changeFailureRate: { rate: 0, deployTimeFailures: 0, postDeployFailures: 0, attempts: 0, level: cfr },
    }],
    meanTimeToRestore: { incidents: 0, restored: 0, medianSeconds: null, level: mttr },
    coverage: { registered: 0, deploying: 0, withoutDeploys: 0 },
  };
}

describe('complianceScore', () => {
  it('is null when no rules were evaluated', () => {
    expect(complianceScore({ rulesEvaluated: 0, violations: 0, warnings: 0 })).toBeNull();
  });
  it('is the pass ratio', () => {
    expect(complianceScore({ rulesEvaluated: 10, violations: 1, warnings: 0 })).toBe(90);
  });
  it('weights a warning as half a violation', () => {
    expect(complianceScore({ rulesEvaluated: 10, violations: 0, warnings: 2 })).toBe(90);
  });
  it('clamps to 0 when violations exceed rules', () => {
    expect(complianceScore({ rulesEvaluated: 2, violations: 5, warnings: 0 })).toBe(0);
  });
});

describe('doraScoreFromMetrics', () => {
  it('is null when every band is null', () => {
    expect(doraScoreFromMetrics(dora([null, null, null, null]))).toBeNull();
  });
  it('averages the present bands', () => {
    // elite=100, high=80, medium=55, low=30 → avg 66.25 → 66
    expect(doraScoreFromMetrics(dora(['elite', 'high', 'medium', 'low']))).toBe(66);
  });
  it('ignores null bands in the average', () => {
    // elite=100, high=80 → avg 90
    expect(doraScoreFromMetrics(dora(['elite', 'high', null, null]))).toBe(90);
  });
});

describe('insufficient DORA bands (below MIN_DORA_SAMPLE)', () => {
  it('are unscored, not low: they drop out of the average', () => {
    // Were they scored as low (30), this would be (100 + 30) / 2 = 65.
    expect(doraScoreFromMetrics(dora(['elite', 'insufficient', 'insufficient', 'insufficient']))).toBe(100);
  });
  it('leave DORA unscored when every band is insufficient', () => {
    expect(doraScoreFromMetrics(dora(['insufficient', 'insufficient', 'insufficient', 'insufficient']))).toBeNull();
  });
  it('the scorecard carries each band\'s sample so the UI can say "Not enough data (n = X)"', () => {
    const d = dora(['insufficient', 'insufficient', 'insufficient', 'insufficient']);
    d.environments[0].deploymentFrequency.n = 3;
    d.environments[0].changeFailureRate.n = 4;
    d.environments[0].leadTime.n = 2;
    d.meanTimeToRestore.n = 1;
    const card = buildScorecard('p1', d, { rulesEvaluated: 0, violations: 0, warnings: 0 }, 'now');
    expect(card.dora).toMatchObject({
      score: null,
      deploymentFrequency: 'insufficient',
      samples: { deploymentFrequency: 3, changeFailureRate: 4, meanTimeToRestore: 1, leadTime: 2 },
    });
    expect(card.grade).toBe('N/A');
  });
});

describe('combineScore', () => {
  it('is null when both dimensions are null', () => expect(combineScore(null, null)).toBeNull());
  it('falls back to the single present dimension', () => {
    expect(combineScore(90, null)).toBe(90);
    expect(combineScore(null, 60)).toBe(60);
  });
  it('blends 50/50 when both present', () => expect(combineScore(80, 60)).toBe(70));
});

describe('gradeForScore', () => {
  it('maps to letter bands', () => {
    expect(gradeForScore(95)).toBe('A');
    expect(gradeForScore(80)).toBe('B');
    expect(gradeForScore(65)).toBe('C');
    expect(gradeForScore(50)).toBe('D');
    expect(gradeForScore(30)).toBe('F');
    expect(gradeForScore(null)).toBe('N/A');
  });
});

describe('buildScorecard', () => {
  it('assembles both dimensions into a graded scorecard', () => {
    const sc = buildScorecard('p1', dora(['high', 'high', 'medium', 'high']), { rulesEvaluated: 10, violations: 1, warnings: 0 }, 'now');
    expect(sc.pipelineId).toBe('p1');
    expect(sc.compliance.score).toBe(90);
    expect(sc.dora.score).toBe(74); // (80+80+55+80)/4 = 73.75 → 74
    expect(sc.score).toBe(82); // 0.5*90 + 0.5*74 = 82
    expect(sc.grade).toBe('B');
  });
  it('scores on DORA alone when there are no rules', () => {
    const sc = buildScorecard('p2', dora(['elite', 'elite', 'elite', 'elite']), { rulesEvaluated: 0, violations: 0, warnings: 0 }, 'now');
    expect(sc.compliance.score).toBeNull();
    expect(sc.dora.score).toBe(100);
    expect(sc.score).toBe(100);
    expect(sc.grade).toBe('A');
  });

  it('consumes deploymentFrequency.level from the RESPONSE (not re-derived from perDay)', () => {
    // perDay=0 would derive `null`/`low`, but the response level is authoritative:
    // the scorecard must report exactly what /dora computed.
    const d = dora(['high', null, null, null]);
    d.environments[0].deploymentFrequency = { deployments: 5, perDay: 0, level: 'high' };
    const sc = buildScorecard('p3', d, { rulesEvaluated: 0, violations: 0, warnings: 0 }, 'now');
    expect(sc.dora.deploymentFrequency).toBe('high');
    expect(sc.dora.score).toBe(80); // only the DF band present → 80
  });
});

describe('security dimension', () => {
  const none = { count: 0, critical: 0, high: 0, kev: 0 };

  it('is null with no signal at all (unmeasured is not clean)', () => {
    expect(securityScore({ exposures: none, artifact: null })).toBeNull();
  });

  it('a clean artifact report scores 100', () => {
    expect(securityScore({ exposures: none, artifact: { reports: 1, critical: 0, high: 0, kev: 0, latestAt: null } })).toBe(100);
  });

  it('penalizes KEV over Critical over High, summed across exposures and reports, floored at 0', () => {
    expect(securityScore({ exposures: { count: 1, critical: 1, high: 2, kev: 0 }, artifact: null })).toBe(100 - 15 - 10);
    expect(securityScore({ exposures: { count: 1, critical: 1, high: 0, kev: 1 }, artifact: { reports: 1, critical: 0, high: 1, kev: 0, latestAt: null } })).toBe(100 - 25 - 15 - 5);
    expect(securityScore({ exposures: { count: 3, critical: 9, high: 0, kev: 0 }, artifact: null })).toBe(0);
  });

  it('blends 40/40/20 when security is present, and keeps 50/50 without it', () => {
    expect(combineScore(80, 60, 100)).toBe(76);
    expect(combineScore(80, null, 50)).toBe(Math.round((80 * 0.4 + 50 * 0.2) / 0.6));
    expect(combineScore(80, 60, null)).toBe(70);
  });

  it('lands on the scorecard', () => {
    const sc = buildScorecard('p1', dora(['high', 'high', 'high', 'high']), { rulesEvaluated: 0, violations: 0, warnings: 0 }, 'now', {
      exposures: { count: 1, critical: 1, high: 0, kev: 0 }, artifact: null,
    });
    expect(sc.security).toEqual({ score: 85, exposures: { count: 1, critical: 1, high: 0, kev: 0 }, artifact: null });
    expect(sc.score).toBe(Math.round((80 * 0.4 + 85 * 0.2) / 0.6));
  });
});

describe('scorecardWindows (grade-history windows)', () => {
  const now = new Date('2026-11-20T15:00:00Z'); // a Friday

  it('returns N ISO weeks oldest-first, the last one partial (ending now)', () => {
    const w = scorecardWindows(now, 'week', 3, { tz: 'UTC', weekStart: 'monday' });
    expect(w.map((x) => x.label)).toEqual(['2026-W45', '2026-W46', '2026-W47']);
    expect(w[0]).toMatchObject({ from: '2026-11-02T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z', partial: false, truncated: false });
    expect(w[2]).toMatchObject({ from: '2026-11-16T00:00:00.000Z', to: now.toISOString(), partial: true });
  });

  it('aligns week and month boundaries to the viewer timezone and week start', () => {
    const w = scorecardWindows(now, 'week', 1, { tz: 'America/Chicago', weekStart: 'sunday' });
    // Sunday 2026-11-15 00:00 in Chicago (CST, UTC-6).
    expect(w[0].from).toBe('2026-11-15T06:00:00.000Z');
    const m = scorecardWindows(now, 'month', 2, { tz: 'America/Chicago', weekStart: 'monday' });
    expect(m.map((x) => x.label)).toEqual(['2026-10', '2026-11']);
    // Oct 1 00:00 CDT (UTC-5) → Nov 1 00:00 CDT.
    expect(m[0]).toMatchObject({ from: '2026-10-01T05:00:00.000Z', to: '2026-11-01T05:00:00.000Z' });
  });

  it('caps the number of windows', () => {
    expect(scorecardWindows(now, 'week', 99, { tz: 'UTC', weekStart: 'monday' })).toHaveLength(SCORECARD_HISTORY_MAX_PERIODS);
  });

  it('floors at the DORA retention horizon: drops windows wholly before it, truncates the one it cuts', () => {
    const minFromMs = Date.parse('2026-11-05T00:00:00Z');
    const w = scorecardWindows(now, 'week', 4, { tz: 'UTC', weekStart: 'monday', minFromMs });
    expect(w.map((x) => x.label)).toEqual(['2026-W45', '2026-W46', '2026-W47']);
    expect(w[0]).toMatchObject({ from: '2026-11-05T00:00:00.000Z', truncated: true });
    expect(w[1].truncated).toBe(false);
  });
});

describe('averageScore', () => {
  it('rounds the mean of the scored entries and ignores the unscored', () => {
    expect(averageScore([80, null, 71])).toBe(76);
    expect(averageScore([null])).toBeNull();
    expect(averageScore([])).toBeNull();
  });
});
