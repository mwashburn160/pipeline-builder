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
} from '../src/helpers/scorecard.js';

type Level = 'elite' | 'high' | 'medium' | 'low' | null;

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
