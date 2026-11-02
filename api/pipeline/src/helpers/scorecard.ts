// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { DoraLevel, DoraMetrics } from '@pipeline-builder/pipeline-data';

/**
 * Per-pipeline service maturity scorecard. Blends the dimensions the platform
 * already computes — compliance posture (how many of the org's rules the
 * pipeline passes), DORA delivery performance (the four bands) and security
 * (open plugin-image exposures + the pipeline's own artifact scan reports) —
 * into a single 0–100 score and letter grade. Every dimension is independently
 * nullable: a pipeline with no rules, no run history or no security signal
 * scores only on the dimensions that have data.
 */
export type ScorecardGrade = 'A' | 'B' | 'C' | 'D' | 'F' | 'N/A';

export interface ScorecardComplianceInput {
  rulesEvaluated: number;
  violations: number;
  warnings: number;
}

/**
 * The security signal for one pipeline: its LIVE plugin exposures (open, not
 * under an acceptance in force — pipeline-data's `openExposures`) and the summed
 * counts of its latest artifact security reports.
 */
export interface ScorecardSecurityInput {
  exposures: { count: number; critical: number; high: number; kev: number };
  /** Null when the pipeline has never uploaded an artifact report. */
  artifact: { reports: number; critical: number; high: number; kev: number; latestAt: string | null } | null;
}

export interface Scorecard {
  pipelineId: string;
  /** Weighted overall 0–100, or null when neither dimension has data. */
  score: number | null;
  grade: ScorecardGrade;
  /** True when this card could not be COMPUTED (an error), as opposed to
   *  computed with no data. Only set by {@link unavailableScorecard}. */
  unavailable?: boolean;
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
  security: {
    score: number | null;
    exposures: ScorecardSecurityInput['exposures'];
    artifact: ScorecardSecurityInput['artifact'];
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

/** Points a single open finding costs the security score. */
const SECURITY_PENALTY = { kev: 25, critical: 15, high: 5 } as const;

/**
 * Security 0–100: 100 less a penalty per open finding — a KEV-listed one costs
 * most (it is being exploited), then Critical, then High — floored at 0. KEV
 * findings are also Critical/High, so they pay both: known-exploited is worse
 * than merely severe. Null when there is no signal at all: no live exposure AND
 * no artifact report. A pipeline that never scanned what it builds is
 * unmeasured, not clean.
 */
export function securityScore({ exposures, artifact }: ScorecardSecurityInput): number | null {
  if (exposures.count === 0 && artifact === null) return null;
  const kev = exposures.kev + (artifact?.kev ?? 0);
  const critical = exposures.critical + (artifact?.critical ?? 0);
  const high = exposures.high + (artifact?.high ?? 0);
  return Math.max(0, 100 - kev * SECURITY_PENALTY.kev - critical * SECURITY_PENALTY.critical - high * SECURITY_PENALTY.high);
}

/**
 * Blend the dimensions that have data. Compliance + DORA alone stay 50/50; with
 * a security score it is 40/40/20. A missing dimension's weight is spread over
 * the present ones.
 */
export function combineScore(compliance: number | null, dora: number | null, security: number | null = null): number | null {
  const parts: Array<[number, number]> = [];
  if (compliance !== null) parts.push([compliance, security === null ? 0.5 : 0.4]);
  if (dora !== null) parts.push([dora, security === null ? 0.5 : 0.4]);
  if (security !== null) parts.push([security, 0.2]);
  if (parts.length === 0) return null;
  const weight = parts.reduce((a, [, w]) => a + w, 0);
  return Math.round(parts.reduce((a, [v, w]) => a + v * w, 0) / weight);
}

/** No security signal (an unmeasured pipeline, or a card that failed to compute). */
export const NO_SECURITY_SIGNAL: ScorecardSecurityInput = { exposures: { count: 0, critical: 0, high: 0, kev: 0 }, artifact: null };

/**
 * A scorecard for a pipeline whose compute FAILED, so an org-wide roll-up can
 * keep going instead of failing whole-page on one bad pipeline.
 *
 * Distinct from "no data": `score: null` already sinks it to the bottom of the
 * leaderboard, and `unavailable` marks it as *not measured* rather than measured
 * badly — so a reader never mistakes an outage for an F.
 */
export function unavailableScorecard(pipelineId: string, computedAt: string): Scorecard {
  return {
    pipelineId,
    score: null,
    grade: 'N/A',
    unavailable: true,
    compliance: { score: null, rulesEvaluated: 0, violations: 0, warnings: 0 },
    dora: {
      score: null,
      basis: 'deploy',
      deploymentFrequency: null,
      changeFailureRate: null,
      meanTimeToRestore: null,
      leadTime: null,
    },
    security: { score: null, ...NO_SECURITY_SIGNAL },
    computedAt,
  };
}

/** Assemble the scorecard from a DORA result, compliance dry-run counts and the security signal. */
export function buildScorecard(
  pipelineId: string,
  dora: DoraMetrics,
  compliance: ScorecardComplianceInput,
  computedAt: string,
  security: ScorecardSecurityInput = NO_SECURITY_SIGNAL,
): Scorecard {
  const cScore = complianceScore(compliance);
  const dScore = doraScoreFromMetrics(dora);
  const sScore = securityScore(security);
  const overall = combineScore(cScore, dScore, sScore);
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
    security: { score: sScore, exposures: security.exposures, artifact: security.artifact },
    computedAt,
  };
}
