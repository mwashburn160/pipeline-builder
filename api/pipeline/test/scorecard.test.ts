// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import {
  complianceScore,
  doraScoreFromMetrics,
  combineScore,
  gradeForScore,
  buildScorecard,
} from '../src/helpers/scorecard.js';

type Level = 'elite' | 'high' | 'medium' | 'low' | null;

/** Minimal DoraMetrics with the four band levels set. */
function dora(levels: [Level, Level, Level, Level]): any {
  const [df, cfr, mttr, lt] = levels;
  return {
    window: { from: '', to: '' },
    basis: 'run',
    filters: { pipelineId: null, environment: null },
    deploymentFrequency: { deployments: 0, perDay: 0, level: df },
    changeFailureRate: { failed: 0, total: 0, pct: 0, level: cfr },
    meanTimeToRestore: { failures: 0, restored: 0, avgSeconds: null, level: mttr },
    leadTime: { deployments: 0, medianSeconds: null, approx: true, level: lt },
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
});
