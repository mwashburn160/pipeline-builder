// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { DoraLevel, DoraMetrics } from '@pipeline-builder/pipeline-data';

/**
 * Per-pipeline service maturity scorecard. Blends two dimensions the platform
 * already computes — compliance posture (how many of the org's rules the
 * pipeline passes) and DORA delivery performance (the four bands) — into a
 * single 0–100 score and letter grade. Both dimensions are independently
 * nullable: a pipeline with no rules or no run history scores only on the
 * dimension that has data.
 */
export type ScorecardGrade = 'A' | 'B' | 'C' | 'D' | 'F' | 'N/A';

export interface ScorecardComplianceInput {
  rulesEvaluated: number;
  violations: number;
  warnings: number;
}

export interface Scorecard {
  pipelineId: string;
  /** Weighted overall 0–100, or null when neither dimension has data. */
  score: number | null;
  grade: ScorecardGrade;
  compliance: {
    score: number | null;
    rulesEvaluated: number;
    violations: number;
    warnings: number;
  };
  dora: {
    score: number | null;
    basis: 'deploy' | 'run';
    deploymentFrequency: DoraLevel;
    changeFailureRate: DoraLevel;
    meanTimeToRestore: DoraLevel;
    leadTime: DoraLevel;
  };
  computedAt: string;
}

/** Points per DORA performance band (null bands are excluded from the average). */
const BAND_POINTS: Record<Exclude<DoraLevel, null>, number> = {
  elite: 100,
  high: 80,
  medium: 55,
  low: 30,
};

/** Average of the present DORA bands' points (null when every band is null). */
export function doraScoreFromMetrics(d: DoraMetrics): number | null {
  const levels: DoraLevel[] = [
    d.deploymentFrequency.level,
    d.changeFailureRate.level,
    d.meanTimeToRestore.level,
    d.leadTime.level,
  ];
  const points = levels.filter((l): l is Exclude<DoraLevel, null> => l !== null).map(l => BAND_POINTS[l]);
  if (points.length === 0) return null;
  return Math.round(points.reduce((a, b) => a + b, 0) / points.length);
}

/**
 * Compliance posture 0–100: the pass ratio, weighting a warning as half a
 * violation. Null when no rules were evaluated (nothing to grade).
 */
export function complianceScore({ rulesEvaluated, violations, warnings }: ScorecardComplianceInput): number | null {
  if (rulesEvaluated <= 0) return null;
  const passWeighted = rulesEvaluated - violations - 0.5 * warnings;
  const ratio = Math.max(0, Math.min(1, passWeighted / rulesEvaluated));
  return Math.round(ratio * 100);
}

/** Letter grade from a 0–100 score (bands mirror the DORA Elite→Low ladder). */
export function gradeForScore(score: number | null): ScorecardGrade {
  if (score === null) return 'N/A';
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 45) return 'D';
  return 'F';
}

/** Blend compliance + DORA (50/50); fall back to whichever single dimension has data. */
export function combineScore(compliance: number | null, dora: number | null): number | null {
  if (compliance === null && dora === null) return null;
  if (compliance === null) return dora;
  if (dora === null) return compliance;
  return Math.round(0.5 * compliance + 0.5 * dora);
}

/** Assemble the scorecard from a DORA result + compliance dry-run counts. */
export function buildScorecard(
  pipelineId: string,
  dora: DoraMetrics,
  compliance: ScorecardComplianceInput,
  computedAt: string,
): Scorecard {
  const cScore = complianceScore(compliance);
  const dScore = doraScoreFromMetrics(dora);
  const overall = combineScore(cScore, dScore);
  return {
    pipelineId,
    score: overall,
    grade: gradeForScore(overall),
    compliance: {
      score: cScore,
      rulesEvaluated: compliance.rulesEvaluated,
      violations: compliance.violations,
      warnings: compliance.warnings,
    },
    dora: {
      score: dScore,
      basis: dora.basis,
      deploymentFrequency: dora.deploymentFrequency.level,
      changeFailureRate: dora.changeFailureRate.level,
      meanTimeToRestore: dora.meanTimeToRestore.level,
      leadTime: dora.leadTime.level,
    },
    computedAt,
  };
}
