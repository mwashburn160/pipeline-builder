// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The needs-attention rules.
 *
 * The rest of the report describes; this decides. So these tests are mostly about
 * the cases where a naive rule would be CONFIDENTLY WRONG, because a section that
 * decides loses its reader the first time it is:
 *
 *  - a dormant pipeline must not be flagged as 0% success;
 *  - a 2s → 3s jump is 50% and means nothing;
 *  - "70% over a month" and "three failures in a row" need different urgency;
 *  - a pipeline invisible to DORA is a MEASUREMENT gap, not a failure.
 *
 * Every finding carries the number behind it, and that is asserted: a flag without
 * evidence is an opinion the reader has to take on trust.
 */

import { describe, it, expect } from '@jest/globals';
import type { PipelineBreakdownRow } from '../src/api/reporting/analytics-queries.js';
import {
  evaluateNeedsAttention,
  thresholdsFrom,
  DEFAULT_THRESHOLDS,
} from '../src/api/reporting/needs-attention.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');

const row = (over: Partial<PipelineBreakdownRow> = {}): PipelineBreakdownRow => ({
  pipelineId: 'pipe-1',
  pipelineName: 'web-deploy',
  project: 'web',
  runs: 20,
  succeeded: 20,
  failed: 0,
  successPct: 100,
  p95Ms: 120_000,
  deploys: 5,
  lastFailureAt: null,
  lastFailureStage: null,
  buildSeconds: 600,
  ...over,
});

/** The rules that tripped, by id. */
const rules = (items: ReturnType<typeof evaluateNeedsAttention>, pipelineId = 'pipe-1') =>
  (items.find((i) => i.pipelineId === pipelineId)?.findings ?? []).map((f) => f.rule);

const evidenceFor = (items: ReturnType<typeof evaluateNeedsAttention>, rule: string) =>
  items.flatMap((i) => i.findings).find((f) => f.rule === rule)?.evidence ?? '';

describe('a healthy pipeline', () => {
  it('is not flagged at all', () => {
    expect(evaluateNeedsAttention({ current: [row()], now: NOW })).toEqual([]);
  });
});

describe('low success rate', () => {
  it('flags a pipeline below the threshold, with the rate and the volume', () => {
    const items = evaluateNeedsAttention({
      current: [row({ runs: 20, succeeded: 16, failed: 4, successPct: 80 })],
      now: NOW,
    });
    expect(rules(items)).toContain('low_success_rate');
    // The number AND the sample size: 80% of 20 runs and 80% of 2 runs are
    // different claims.
    expect(evidenceFor(items, 'low_success_rate')).toContain('80%');
    expect(evidenceFor(items, 'low_success_rate')).toContain('20 runs');
  });

  it('calls a catastrophic rate high and a marginal one medium', () => {
    const bad = evaluateNeedsAttention({ current: [row({ successPct: 30, failed: 14 })], now: NOW });
    const marginal = evaluateNeedsAttention({ current: [row({ successPct: 88, failed: 2 })], now: NOW });
    expect(bad[0]?.severity).toBe('high');
    expect(marginal[0]?.severity).toBe('medium');
  });

  /**
   * A pipeline nobody ran is not a pipeline that failed. Flagging it as 0% would put
   * every dormant pipeline at the top of the list, forever.
   */
  it('does not flag a pipeline with no runs', () => {
    const items = evaluateNeedsAttention({
      current: [row({ runs: 0, succeeded: 0, failed: 0, successPct: null })],
      now: NOW,
    });
    expect(items).toEqual([]);
  });

  it('honours an org threshold', () => {
    const at95 = evaluateNeedsAttention({
      current: [row({ successPct: 93, failed: 1 })],
      thresholds: { successRatePct: 95 },
      now: NOW,
    });
    expect(rules(at95)).toContain('low_success_rate');
    // …and the same pipeline is fine at the default.
    expect(evaluateNeedsAttention({ current: [row({ successPct: 93, failed: 1 })], now: NOW })).toEqual([]);
  });
});

describe('getting slower', () => {
  it('flags a p95 increase past the threshold, with both durations', () => {
    const items = evaluateNeedsAttention({
      current: [row({ p95Ms: 331_000 })],
      previous: [row({ p95Ms: 252_000 })],
      now: NOW,
    });
    expect(rules(items)).toContain('slower_p95');
    const evidence = evidenceFor(items, 'slower_p95');
    expect(evidence).toMatch(/p95 up 3[01]%/);
    // Durations a person reads, not milliseconds.
    expect(evidence).toContain('4m12s');
    expect(evidence).toContain('5m31s');
  });

  /**
   * A jump from 2s to 3s is 50% and means nothing. A percentage off a tiny baseline
   * is the classic way an alert becomes noise.
   */
  it('ignores a large percentage off a trivial baseline', () => {
    const items = evaluateNeedsAttention({
      current: [row({ p95Ms: 3_000 })],
      previous: [row({ p95Ms: 2_000 })],
      now: NOW,
    });
    expect(rules(items)).not.toContain('slower_p95');
  });

  it('says nothing when there is no previous period to compare', () => {
    expect(rules(evaluateNeedsAttention({ current: [row({ p95Ms: 900_000 })], now: NOW })))
      .not.toContain('slower_p95');
  });

  it('does not flag a pipeline that got faster', () => {
    const items = evaluateNeedsAttention({
      current: [row({ p95Ms: 100_000 })],
      previous: [row({ p95Ms: 300_000 })],
      now: NOW,
    });
    expect(rules(items)).not.toContain('slower_p95');
  });

  it('calls a doubling high and a drift medium', () => {
    const drift = evaluateNeedsAttention({
      current: [row({ p95Ms: 130_000 })], previous: [row({ p95Ms: 100_000 })], now: NOW,
    });
    const bad = evaluateNeedsAttention({
      current: [row({ p95Ms: 300_000 })], previous: [row({ p95Ms: 100_000 })], now: NOW,
    });
    expect(drift[0]?.findings[0]?.severity).toBe('medium');
    expect(bad[0]?.findings[0]?.severity).toBe('high');
  });
});

describe('consecutive failures', () => {
  /**
   * The clearest "broken now" signal there is. A 70% success rate over a month and
   * three failures in a row are very different situations, and only the second needs
   * somebody today — which is why this is always high.
   */
  it('is always high, and says how many', () => {
    const items = evaluateNeedsAttention({
      current: [row({ successPct: 95, failed: 3 })],
      streaks: new Map([['pipe-1', { consecutiveFailures: 4, lastSuccessAt: NOW }]]),
      now: NOW,
    });
    expect(rules(items)).toContain('consecutive_failures');
    expect(evidenceFor(items, 'consecutive_failures')).toContain('4 consecutive');
    expect(items[0]?.severity).toBe('high');
  });

  it('does not trip below the threshold', () => {
    const items = evaluateNeedsAttention({
      current: [row()],
      streaks: new Map([['pipe-1', { consecutiveFailures: 2, lastSuccessAt: NOW }]]),
      now: NOW,
    });
    expect(rules(items)).not.toContain('consecutive_failures');
  });
});

describe('no recent success', () => {
  /**
   * Distinct from the rate: a pipeline that succeeded 90% of the time and then
   * stopped succeeding entirely looks fine by rate and is completely broken.
   */
  it('flags a pipeline that has not succeeded in the whole period', () => {
    const items = evaluateNeedsAttention({
      current: [row({ runs: 6, succeeded: 0, failed: 6, successPct: 0 })],
      streaks: new Map([['pipe-1', { consecutiveFailures: 1, lastSuccessAt: null }]]),
      now: NOW,
    });
    expect(rules(items)).toContain('no_recent_success');
    expect(evidenceFor(items, 'no_recent_success')).toContain('6 attempts');
  });

  it('flags a stale last success, with the age', () => {
    const items = evaluateNeedsAttention({
      current: [row()],
      streaks: new Map([['pipe-1', {
        consecutiveFailures: 0,
        lastSuccessAt: new Date(NOW.getTime() - 9 * 86_400_000),
      }]]),
      now: NOW,
    });
    expect(evidenceFor(items, 'no_recent_success')).toContain('9 days ago');
  });

  it('does not flag a recent success', () => {
    const items = evaluateNeedsAttention({
      current: [row()],
      streaks: new Map([['pipe-1', { consecutiveFailures: 0, lastSuccessAt: new Date(NOW.getTime() - 3600_000) }]]),
      now: NOW,
    });
    expect(rules(items)).not.toContain('no_recent_success');
  });

  it('says nothing for a pipeline that never ran', () => {
    const items = evaluateNeedsAttention({
      current: [row({ runs: 0, successPct: null })],
      streaks: new Map([['pipe-1', { consecutiveFailures: 0, lastSuccessAt: null }]]),
      now: NOW,
    });
    expect(items).toEqual([]);
  });
});

describe('failed after a configuration change', () => {
  /**
   * The most useful correlation in the section, because it names a likely CAUSE
   * rather than a symptom — and it is the one a human would otherwise work out by
   * hand from two screens.
   */
  it('flags a failure shortly after a change, and names the stage', () => {
    const changedAt = new Date(NOW.getTime() - 5 * 3600_000);
    const items = evaluateNeedsAttention({
      current: [row({ lastFailureAt: NOW.toISOString(), lastFailureStage: 'Deploy', failed: 1, successPct: 95 })],
      configChanges: new Map([['pipe-1', changedAt]]),
      now: NOW,
    });
    expect(rules(items)).toContain('failed_after_config_change');
    expect(evidenceFor(items, 'failed_after_config_change')).toContain('5h after');
    expect(evidenceFor(items, 'failed_after_config_change')).toContain('Deploy');
  });

  it('phrases a very recent one in words rather than "0h"', () => {
    const items = evaluateNeedsAttention({
      current: [row({ lastFailureAt: NOW.toISOString(), failed: 1 })],
      configChanges: new Map([['pipe-1', new Date(NOW.getTime() - 600_000)]]),
      now: NOW,
    });
    expect(evidenceFor(items, 'failed_after_config_change')).toContain('less than an hour');
  });

  it('does not correlate a failure that came BEFORE the change', () => {
    const items = evaluateNeedsAttention({
      current: [row({ lastFailureAt: new Date(NOW.getTime() - 7200_000).toISOString(), failed: 1 })],
      configChanges: new Map([['pipe-1', NOW]]),
      now: NOW,
    });
    expect(rules(items)).not.toContain('failed_after_config_change');
  });

  it('does not correlate a failure long after the change', () => {
    const items = evaluateNeedsAttention({
      current: [row({ lastFailureAt: NOW.toISOString(), failed: 1 })],
      configChanges: new Map([['pipe-1', new Date(NOW.getTime() - 5 * 86_400_000)]]),
      now: NOW,
    });
    expect(rules(items)).not.toContain('failed_after_config_change');
  });
});

describe('supply chain and measurement', () => {
  it('flags a pipeline running a plugin with open Criticals', () => {
    const items = evaluateNeedsAttention({
      current: [row()],
      vulnerablePipelines: new Set(['pipe-1']),
      now: NOW,
    });
    expect(rules(items)).toContain('vulnerable_plugin');
    expect(items[0]?.severity).toBe('high');
  });

  /**
   * A MEASUREMENT gap, not a failure — and flagged because a pipeline nobody can
   * see deploying is the reason a deployment-frequency number is wrong, and nothing
   * else in the report would say so.
   */
  it('flags a pipeline invisible to DORA as medium, with the fix', () => {
    const items = evaluateNeedsAttention({
      current: [row()],
      untrackedPipelines: new Set(['pipe-1']),
      now: NOW,
    });
    expect(rules(items)).toContain('no_deploy_tracking');
    expect(items[0]?.severity).toBe('medium');
    expect(evidenceFor(items, 'no_deploy_tracking')).toContain('re-synth');
  });

  it('does not flag an untracked pipeline that never ran', () => {
    const items = evaluateNeedsAttention({
      current: [row({ runs: 0, successPct: null })],
      untrackedPipelines: new Set(['pipe-1']),
      now: NOW,
    });
    expect(items).toEqual([]);
  });
});

describe('the list itself', () => {
  it('puts high before medium, then the most-wrong first', () => {
    const items = evaluateNeedsAttention({
      current: [
        row({ pipelineId: 'medium-one', successPct: 88, failed: 2 }),
        row({ pipelineId: 'high-one', successPct: 20, failed: 16 }),
        row({ pipelineId: 'high-two', successPct: 20, failed: 16 }),
      ],
      vulnerablePipelines: new Set(['high-two']),
      now: NOW,
    });
    expect(items.map((i) => i.pipelineId)).toEqual(['high-two', 'high-one', 'medium-one']);
  });

  it('collects every finding for one pipeline into one item', () => {
    const items = evaluateNeedsAttention({
      current: [row({ successPct: 40, failed: 12, p95Ms: 400_000, lastFailureAt: NOW.toISOString() })],
      previous: [row({ p95Ms: 100_000 })],
      streaks: new Map([['pipe-1', { consecutiveFailures: 5, lastSuccessAt: null }]]),
      configChanges: new Map([['pipe-1', new Date(NOW.getTime() - 3600_000)]]),
      vulnerablePipelines: new Set(['pipe-1']),
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.findings.length).toBeGreaterThanOrEqual(5);
  });

  /** A flag without the number behind it is an opinion the reader must trust. */
  it('gives every finding real evidence', () => {
    const items = evaluateNeedsAttention({
      current: [row({ successPct: 40, failed: 12 })],
      streaks: new Map([['pipe-1', { consecutiveFailures: 5, lastSuccessAt: null }]]),
      vulnerablePipelines: new Set(['pipe-1']),
      untrackedPipelines: new Set(['pipe-1']),
      now: NOW,
    });
    for (const f of items[0]?.findings ?? []) {
      expect(f.evidence.length).toBeGreaterThan(15);
      expect(['high', 'medium']).toContain(f.severity);
    }
  });

  it('returns nothing for an empty period', () => {
    expect(evaluateNeedsAttention({ current: [], now: NOW })).toEqual([]);
  });
});

describe('thresholdsFrom', () => {
  it('falls back PER FIELD, so setting one does not disable the rest', () => {
    const t = thresholdsFrom({ successRatePct: 95 });
    expect(t.successRatePct).toBe(95);
    expect(t.consecutiveFailures).toBe(DEFAULT_THRESHOLDS.consecutiveFailures);
    expect(t.staleDays).toBe(DEFAULT_THRESHOLDS.staleDays);
  });

  it('returns the defaults for null or undefined', () => {
    expect(thresholdsFrom(null)).toEqual(DEFAULT_THRESHOLDS);
    expect(thresholdsFrom(undefined)).toEqual(DEFAULT_THRESHOLDS);
  });
});
