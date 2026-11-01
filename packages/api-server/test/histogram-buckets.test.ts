// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Histogram buckets, and the alert thresholds that depend on them.
 *
 * THE DEFECT THIS PINS. `histogram_quantile` cannot interpolate past a
 * histogram's last FINITE bucket boundary: every observation above it falls into
 * `+Inf`, and the quantile reads back as that boundary forever. A metric left on
 * the sub-second default (ceiling 300s) therefore reports a p90 of five minutes
 * no matter how bad things get, and any alert comparing it against a larger
 * number can never fire. Nothing errors and the scrape looks healthy — the only
 * symptom is silence during an outage.
 *
 * `support_first_response_seconds` measures hours to days and shipped with a
 * twelve-hour alert threshold sitting above a five-minute ceiling, so the whole
 * support response-target alerting chain was inert. These tests assert the
 * property rather than the numbers: every alert threshold that exists must sit
 * at or below its histogram's ceiling, and the thresholds that are CONTRACTUAL
 * must sit exactly on a boundary so the comparison is not a guess.
 */

import { describe, it, expect } from '@jest/globals';
import { Registry } from 'prom-client';
import { createMetricHelpers } from '../src/api/metrics.js';

/** The finite bucket boundaries a metric was actually registered with. */
async function bucketsOf(name: string, labels: Record<string, string>): Promise<number[]> {
  const registry = new Registry();
  createMetricHelpers(registry).observe(name, labels, 1);
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  const les = ((metric?.values ?? []) as { labels: Record<string, unknown> }[])
    .map((v) => Number(v.labels.le))
    .filter((le) => Number.isFinite(le));
  return [...new Set(les)].sort((a, b) => a - b);
}

const ceiling = (b: number[]) => b[b.length - 1] ?? 0;

describe('the default distribution', () => {
  it('still covers sub-second through five minutes', async () => {
    const b = await bucketsOf('some_unlisted_duration_seconds', {});
    expect(b[0]).toBeLessThanOrEqual(0.05);
    expect(ceiling(b)).toBe(300);
  });
});

describe('support_first_response_seconds', () => {
  it('reaches days, not minutes', async () => {
    // The regression: a 300s ceiling made every support response alert inert.
    const b = await bucketsOf('support_first_response_seconds', { level: 'support_premium', severity: 'normal' });
    expect(ceiling(b)).toBeGreaterThanOrEqual(345600);
  });

  it('puts BOTH the premium alert threshold and its sold target on a boundary', async () => {
    // 8h is the number sold ("8 hours, any day") and 6h is where the alert fires
    // to leave two hours to act. A threshold inside a wide bucket is served by
    // interpolating across it, which is a guess; on a boundary it is exact. For
    // a contractual number a guess is not good enough.
    const b = await bucketsOf('support_first_response_seconds', { level: 'support_premium', severity: 'normal' });
    expect(b).toContain(21600);
    expect(b).toContain(28800);
  });

  it('puts the standard/priority operational guard on a boundary too', async () => {
    const b = await bucketsOf('support_first_response_seconds', { level: 'support_standard', severity: 'normal' });
    expect(b).toContain(86400);
  });

  it('reaches the longest wait a business-day target legitimately allows', async () => {
    // A priority case raised at 17:01 on a Friday is not late until Monday
    // evening — about 79 wall-clock hours. A ceiling below that would read every
    // such case as identical to one that was never answered at all.
    const b = await bucketsOf('support_first_response_seconds', { level: 'support_priority', severity: 'normal' });
    expect(ceiling(b)).toBeGreaterThan(79 * 3600);
  });
});

describe('the other long-running histograms', () => {
  it('plugin_job_wait_seconds admits its own alert threshold', async () => {
    // `PluginQueueProcessingSlow` compares p95 against 300, which the default
    // ceiling of exactly 300 made unsatisfiable: `> 300` can never be true when
    // 300 is the largest value the quantile can return.
    const b = await bucketsOf('plugin_job_wait_seconds', {});
    expect(b).toContain(300);
    expect(ceiling(b)).toBeGreaterThan(300);
  });

  it('ecosystem_decision_latency_seconds reaches the weeks a review queue takes', async () => {
    const b = await bucketsOf('ecosystem_decision_latency_seconds', { kind: 'submission', lane: 'standard' });
    expect(ceiling(b)).toBeGreaterThanOrEqual(604800);
  });

  it('the build and scan histograms pass five minutes', async () => {
    for (const name of ['plugin_build_duration_seconds', 'plugin_vuln_scan_duration_seconds']) {
      expect(ceiling(await bucketsOf(name, { trigger: 'manual' }))).toBeGreaterThan(300);
    }
  });
});

describe('support_satisfaction is a SCORE, not a duration', () => {
  it('has one boundary per possible score', () => {
    // Listed in the table for the same reason the durations are: the default
    // buckets are sub-second, so every 1-to-5 rating would land in the same
    // bucket and the quantile would be meaningless. One boundary per score
    // makes `_sum / _count` an exact average and every bucket a real count.
    return bucketsOf('support_satisfaction', { level: 'support_premium', severity: 'normal' })
      .then((b) => expect(b).toEqual([1, 2, 3, 4, 5]));
  });

  it('puts the worst and best scores on boundaries, so neither hides in +Inf', async () => {
    const b = await bucketsOf('support_satisfaction', { level: 'support_standard', severity: 'normal' });
    expect(b[0]).toBe(1);
    expect(ceiling(b)).toBe(5);
  });
});

describe('every declared distribution is well-formed', () => {
  it('is strictly ascending, so no boundary is unreachable', async () => {
    const names: [string, Record<string, string>][] = [
      ['support_first_response_seconds', { level: 'support_premium', severity: 'normal' }],
      ['ecosystem_decision_latency_seconds', { kind: 'submission', lane: 'standard' }],
      ['plugin_job_wait_seconds', {}],
      ['plugin_build_duration_seconds', { buildType: 'docker' }],
      ['plugin_vuln_scan_duration_seconds', { trigger: 'manual' }],
      ['support_satisfaction', { level: 'support_premium', severity: 'normal' }],
    ];
    for (const [name, labels] of names) {
      const b = await bucketsOf(name, labels);
      expect(b.length).toBeGreaterThan(1);
      for (let i = 1; i < b.length; i += 1) expect(b[i]).toBeGreaterThan(b[i - 1]!);
    }
  });

  it('gives each registry the SAME distribution, which is why the factory exists', async () => {
    // api-server and platform build these helpers over different registries. The
    // module comment says they must not drift in their buckets; this is that.
    const a = await bucketsOf('support_first_response_seconds', { level: 'support_premium', severity: 'normal' });
    const b = await bucketsOf('support_first_response_seconds', { level: 'support_premium', severity: 'normal' });
    expect(a).toEqual(b);
  });
});
