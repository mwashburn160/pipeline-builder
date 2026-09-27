// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which pipelines need somebody to look at them, and WHY.
 *
 * The rest of the report describes; this decides. That is a meaningful difference,
 * and it is why every finding carries its EVIDENCE — "p95 up 31%, 4m12s → 5m31s",
 * not "performance degraded". A flag without the number behind it is an opinion the
 * reader has to take on trust, and the first time one is wrong the whole section
 * stops being read.
 *
 * THE THRESHOLDS ARE ORG-CONFIGURABLE, with defaults stated below. They have to be:
 * 90% success is a crisis for a deploy pipeline and unremarkable for a flaky
 * integration suite somebody is already rewriting, and a platform-imposed number
 * would make the section wrong for one of them by construction.
 *
 * WHAT IS DELIBERATELY NOT A RULE: anything per-person, anything about volume
 * ("this team shipped less than that team"), and anything comparing one team to
 * another. Those are the flags that turn a delivery report into a performance
 * review, which is the failure mode this whole feature is trying to avoid.
 */

import type { PipelineBreakdownRow } from './analytics-queries.js';

/** The thresholds a rule trips at. Every one is overridable per org. */
export interface NeedsAttentionThresholds {
  /** Success rate below this, as a percentage. */
  successRatePct: number;
  /** p95 duration up by more than this, as a percentage of the previous period. */
  p95IncreasePct: number;
  /** This many consecutive failures. */
  consecutiveFailures: number;
  /** No successful run in this many days. */
  staleDays: number;
  /** A failure within this many hours of a pipeline configuration change. */
  failureAfterChangeHours: number;
}

/**
 * The defaults.
 *
 * Each is the point at which a reasonable lead would want to know, not the point at
 * which something is definitely wrong — the section's job is to raise attention,
 * and a threshold set where the problem is already undeniable raises it too late.
 */
export const DEFAULT_THRESHOLDS: Readonly<NeedsAttentionThresholds> = Object.freeze({
  successRatePct: 90,
  p95IncreasePct: 25,
  consecutiveFailures: 3,
  staleDays: 7,
  failureAfterChangeHours: 24,
});

/** Why a pipeline was flagged. The id is stable; the evidence is human. */
export type AttentionRuleId =
  | 'low_success_rate'
  | 'slower_p95'
  | 'consecutive_failures'
  | 'no_recent_success'
  | 'failed_after_config_change'
  | 'vulnerable_plugin'
  | 'no_deploy_tracking';

/** One finding about one pipeline. */
export interface AttentionFinding {
  rule: AttentionRuleId;
  /** The sentence a lead reads, with the number in it. */
  evidence: string;
  /** `high` means "this is broken now"; `medium` means "this is drifting". */
  severity: 'high' | 'medium';
}

/** A flagged pipeline and everything that tripped. */
export interface AttentionItem {
  pipelineId: string;
  pipelineName: string | null;
  findings: AttentionFinding[];
  /** The worst severity among the findings — what the list sorts on. */
  severity: 'high' | 'medium';
}

/** What the evaluator needs beyond the current period's breakdown. */
export interface AttentionInput {
  current: readonly PipelineBreakdownRow[];
  /** The previous period, for the p95 comparison. Absent ⇒ that rule is skipped. */
  previous?: readonly PipelineBreakdownRow[];
  /** Per pipeline: consecutive failures ending the period, and last success. */
  streaks?: ReadonlyMap<string, { consecutiveFailures: number; lastSuccessAt: Date | null }>;
  /** Per pipeline: the most recent config change, from the audit trail. */
  configChanges?: ReadonlyMap<string, Date>;
  /** Pipelines with an open Critical plugin exposure. */
  vulnerablePipelines?: ReadonlySet<string>;
  /** Pipelines that ran but produced no deploy rows — DORA cannot see them. */
  untrackedPipelines?: ReadonlySet<string>;
  thresholds?: Partial<NeedsAttentionThresholds>;
  now?: Date;
}

/** `272000` → `4m32s`, for evidence a person reads. */
function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

/**
 * Evaluate every rule against the period.
 *
 * Returns only the pipelines that tripped something, worst first, so the section is
 * a short list of things to do rather than a table of everything.
 */
export function evaluateNeedsAttention(input: AttentionInput): AttentionItem[] {
  const t = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const now = input.now ?? new Date();
  const priorByPipeline = new Map((input.previous ?? []).map((p) => [p.pipelineId, p]));
  const items: AttentionItem[] = [];

  for (const row of input.current) {
    const findings: AttentionFinding[] = [];

    // 1. Success rate. Skipped entirely for a pipeline with no runs: a pipeline
    // nobody ran has no success rate, and flagging it as 0% would put every
    // dormant pipeline at the top of the list forever.
    if (row.runs > 0 && row.successPct !== null && row.successPct < t.successRatePct) {
      findings.push({
        rule: 'low_success_rate',
        severity: row.successPct < t.successRatePct / 2 ? 'high' : 'medium',
        evidence: `${row.successPct}% of ${row.runs} runs succeeded (below ${t.successRatePct}%)`,
      });
    }

    // 2. Getting slower. Needs both periods AND a real baseline — a jump from 2s
    // to 3s is 50% and means nothing, so a tiny baseline is not evidence.
    const prior = priorByPipeline.get(row.pipelineId);
    if (row.p95Ms !== null && prior?.p95Ms && prior.p95Ms > 10_000) {
      const deltaPct = ((row.p95Ms - prior.p95Ms) / prior.p95Ms) * 100;
      if (deltaPct > t.p95IncreasePct) {
        findings.push({
          rule: 'slower_p95',
          severity: deltaPct > t.p95IncreasePct * 2 ? 'high' : 'medium',
          evidence: `p95 up ${deltaPct.toFixed(0)}%, ${duration(prior.p95Ms)} → ${duration(row.p95Ms)}`,
        });
      }
    }

    const streak = input.streaks?.get(row.pipelineId);

    // 3. Consecutive failures. The clearest "this is broken now" signal there is:
    // a 70% success rate over a month and three failures in a row are very
    // different situations, and only the second needs somebody today.
    if (streak && streak.consecutiveFailures >= t.consecutiveFailures) {
      findings.push({
        rule: 'consecutive_failures',
        severity: 'high',
        evidence: `${streak.consecutiveFailures} consecutive failures`,
      });
    }

    // 4. Nothing has worked lately. Distinct from the rate: a pipeline that
    // succeeded 90% of the time and then stopped succeeding entirely looks fine
    // by rate and is completely broken.
    if (streak && row.runs > 0) {
      const days = streak.lastSuccessAt
        ? Math.floor((now.getTime() - streak.lastSuccessAt.getTime()) / 86_400_000)
        : null;
      if (days === null) {
        findings.push({
          rule: 'no_recent_success',
          severity: 'high',
          evidence: `no successful run in this period (${row.runs} attempts)`,
        });
      } else if (days >= t.staleDays) {
        findings.push({
          rule: 'no_recent_success',
          severity: days >= t.staleDays * 2 ? 'high' : 'medium',
          evidence: `last succeeded ${days} days ago`,
        });
      }
    }

    // 5. Broke shortly after somebody changed it. The most useful correlation in
    // the whole section, because it names a likely cause rather than a symptom —
    // and it is the one a human would work out by hand from two screens.
    const changedAt = input.configChanges?.get(row.pipelineId);
    if (changedAt && row.lastFailureAt) {
      const gapHours = (new Date(row.lastFailureAt).getTime() - changedAt.getTime()) / 3600_000;
      if (gapHours >= 0 && gapHours <= t.failureAfterChangeHours) {
        findings.push({
          rule: 'failed_after_config_change',
          severity: 'high',
          evidence: `failed ${gapHours < 1 ? 'less than an hour' : `${Math.round(gapHours)}h`} after a configuration change`
            + (row.lastFailureStage ? ` (${row.lastFailureStage})` : ''),
        });
      }
    }

    // 6. Running a plugin version with open Critical findings.
    if (input.vulnerablePipelines?.has(row.pipelineId)) {
      findings.push({
        rule: 'vulnerable_plugin',
        severity: 'high',
        evidence: 'runs a plugin version with open Critical vulnerabilities',
      });
    }

    // 7. Invisible to DORA. Not a failure — a MEASUREMENT gap, and flagged
    // because a pipeline nobody can see deploying is the reason a deployment-
    // frequency number is wrong, and nothing else in the report would say so.
    if (input.untrackedPipelines?.has(row.pipelineId) && row.runs > 0) {
      findings.push({
        rule: 'no_deploy_tracking',
        severity: 'medium',
        evidence: 'ran, but produced no deploy data — re-synth to include deploy tags',
      });
    }

    if (findings.length > 0) {
      items.push({
        pipelineId: row.pipelineId,
        pipelineName: row.pipelineName,
        findings,
        severity: findings.some((f) => f.severity === 'high') ? 'high' : 'medium',
      });
    }
  }

  // High first, then the pipelines with the most wrong with them.
  return items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    return b.findings.length - a.findings.length;
  });
}

/**
 * Read an org's thresholds out of stored settings, falling back per field.
 *
 * Per FIELD, not per object: an org that set only `successRatePct` keeps the
 * defaults for everything else, rather than silently disabling four rules by
 * configuring one.
 */
export function thresholdsFrom(stored: Partial<NeedsAttentionThresholds> | null | undefined): NeedsAttentionThresholds {
  return { ...DEFAULT_THRESHOLDS, ...(stored ?? {}) };
}
