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
    basis: 'deploy';
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

/** The headline environment's metrics (`production`, else the first), or undefined
 *  when the pipeline has no deploy-attributed environment in the window. Deployment
 *  frequency / lead time / CFR are per-environment in the DORA response. */
function headlineEnv(d: DoraMetrics): DoraMetrics['environments'][number] | undefined {
  return d.environments.find(e => e.environment === d.headline) ?? d.environments[0];
}

/** Average of the present DORA bands' points (null when every band is null).
 *  Scored on the headline environment: deploy frequency, CFR, lead time (all
 *  per-env), plus production MTTR. Every per-env band — deployment frequency
 *  included — carries its own `level` in the DoraMetrics response, so we consume
 *  it directly rather than re-deriving the DF band from `perDay`. */
export function doraScoreFromMetrics(d: DoraMetrics): number | null {
  const env = headlineEnv(d);
  const levels: DoraLevel[] = [
    env?.deploymentFrequency.level ?? null,
    env?.changeFailureRate.level ?? null,
    d.meanTimeToRestore.level,
    env?.leadTime.level ?? null,
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
  const env = headlineEnv(dora);
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
      // Deploy-basis is the only mode now (run-basis removed); lead time is MEASURED.
      basis: 'deploy',
      deploymentFrequency: env?.deploymentFrequency.level ?? null,
      changeFailureRate: env?.changeFailureRate.level ?? null,
      meanTimeToRestore: dora.meanTimeToRestore.level,
      leadTime: env?.leadTime.level ?? null,
    },
    computedAt,
  };
}
