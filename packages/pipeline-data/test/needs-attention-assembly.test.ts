// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How the needs-attention section's SIX inputs are assembled.
 *
 * `needs-attention.test.ts` tests the rules. This tests the gathering, and the two
 * decisions that only exist here:
 *
 *  - EVERY INPUT EXCEPT THE BREAKDOWN IS SOFTENED. A rule with no data to run on is
 *    skipped, so one unavailable read costs ONE finding rather than the whole section.
 *    The alternative — a section that fails because the streak query timed out — replaces
 *    six findings with none. The current breakdown is deliberately NOT softened: with no
 *    pipelines there is nothing to decide about, and a silent empty list would read as
 *    "everything is fine".
 *  - THE THRESHOLDS FALL BACK PER FIELD, so an org that configured one number keeps the
 *    defaults for the other four instead of disabling four rules by setting one.
 *
 * `pipelinesEvaluated` is asserted because it is what lets a reader tell an empty list
 * ("nothing tripped") from an empty input ("nothing ran") — the same distinction the rest
 * of the report draws between a zero and a blind spot.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const getPipelineBreakdown = jest.fn<AnyFn>();
const getPipelineStreaks = jest.fn<AnyFn>();
const getPipelineConfigChanges = jest.fn<AnyFn>();
const getVulnerablePipelines = jest.fn<AnyFn>();
const getUntrackedPipelines = jest.fn<AnyFn>();
const mockSelect = jest.fn<AnyFn>();

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ db: { select: mockSelect } }));

jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({ select: mockSelect }),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

// The analytics reads are stubbed so each can be made to FAIL independently — the whole
// point of this file. The real SQL is exercised against a live Postgres in
// `analytics-queries.test.ts`.
const actualQueries = await import('../src/api/reporting/analytics-queries.js');
jest.unstable_mockModule('../src/api/reporting/analytics-queries.js', () => ({
  ...actualQueries,
  getPipelineBreakdown,
  getPipelineStreaks,
  getPipelineConfigChanges,
  getVulnerablePipelines,
  getUntrackedPipelines,
}));

const { ReportingService } = await import('../src/api/reporting-service.js');
type NeedsAttentionThresholds =
  (typeof import('../src/api/reporting/needs-attention.js'))['DEFAULT_THRESHOLDS'];

const SCOPE = { orgId: 'acme', from: '2026-09-14T00:00:00Z', to: '2026-09-21T00:00:00Z' };
const PREVIOUS = { from: '2026-09-07T00:00:00Z', to: '2026-09-14T00:00:00Z' };

const row = (over: Record<string, unknown> = {}) => ({
  pipelineId: 'pipe-1',
  pipelineName: 'web-deploy',
  project: 'web',
  runs: 20,
  succeeded: 12,
  failed: 8,
  successPct: 60,
  p95Ms: 120_000,
  deploys: 2,
  lastFailureAt: null,
  lastFailureStage: null,
  buildSeconds: 600,
  ...over,
});

/** The stored-threshold read, which is a plain select on `dora_settings`. */
function storedThresholds(value: Record<string, number> | null): void {
  mockSelect.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(value === null ? [] : [{ t: value }]) }) }),
  });
}

let service: InstanceType<typeof ReportingService>;

beforeEach(() => {
  jest.clearAllMocks();
  service = new ReportingService();
  getPipelineBreakdown.mockResolvedValue([row()]);
  getPipelineStreaks.mockResolvedValue([]);
  getPipelineConfigChanges.mockResolvedValue(new Map());
  getVulnerablePipelines.mockResolvedValue([]);
  getUntrackedPipelines.mockResolvedValue([]);
  storedThresholds(null);
});

describe('getNeedsAttention', () => {
  it('evaluates the rules over the assembled inputs', async () => {
    getPipelineStreaks.mockResolvedValue([
      { pipelineId: 'pipe-1', consecutiveFailures: 5, lastSuccessAt: null },
    ]);
    const result = await service.getNeedsAttention(SCOPE) as {
      items: Array<{ pipelineId: string; findings: Array<{ rule: string }> }>;
      pipelinesEvaluated: number;
    };
    const rules = result.items[0]?.findings.map((f) => f.rule) ?? [];
    expect(rules).toContain('low_success_rate');
    expect(rules).toContain('consecutive_failures');
    expect(result.pipelinesEvaluated).toBe(1);
  });

  it('reads the PREVIOUS period only when asked for a comparison', async () => {
    await service.getNeedsAttention(SCOPE);
    expect(getPipelineBreakdown).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    getPipelineBreakdown.mockResolvedValue([row()]);
    getPipelineStreaks.mockResolvedValue([]);
    getPipelineConfigChanges.mockResolvedValue(new Map());
    getVulnerablePipelines.mockResolvedValue([]);
    getUntrackedPipelines.mockResolvedValue([]);
    storedThresholds(null);
    await service.getNeedsAttention(SCOPE, PREVIOUS);
    // The second call carries the previous window, so a p95 comparison is possible.
    expect(getPipelineBreakdown).toHaveBeenCalledTimes(2);
    expect(getPipelineBreakdown.mock.calls[1]?.[0]).toMatchObject(PREVIOUS);
  });

  it('skips a rule whose input FAILED, and still returns the rest', async () => {
    getPipelineStreaks.mockRejectedValue(new Error('statement timeout'));
    getVulnerablePipelines.mockResolvedValue(['pipe-1']);
    const result = await service.getNeedsAttention(SCOPE) as {
      items: Array<{ findings: Array<{ rule: string }> }>;
    };
    const rules = result.items[0]?.findings.map((f) => f.rule) ?? [];
    // The streak rules are gone; everything else still ran.
    expect(rules).not.toContain('consecutive_failures');
    expect(rules).toContain('low_success_rate');
    expect(rules).toContain('vulnerable_plugin');
  });

  it('survives EVERY optional input failing', async () => {
    getPipelineStreaks.mockRejectedValue(new Error('x'));
    getPipelineConfigChanges.mockRejectedValue(new Error('x'));
    getVulnerablePipelines.mockRejectedValue(new Error('x'));
    getUntrackedPipelines.mockRejectedValue(new Error('x'));
    const result = await service.getNeedsAttention(SCOPE) as { items: unknown[] };
    // Four dead upstreams still produce the rate finding, because that one needs only the
    // breakdown — which is the input that is deliberately not softened.
    expect(result.items).toHaveLength(1);
  });

  it('propagates a failure of the breakdown itself', async () => {
    getPipelineBreakdown.mockRejectedValue(new Error('db down'));
    // Not softened on purpose: with no pipelines there is nothing to decide about, and an
    // empty list would read as "everything is fine".
    await expect(service.getNeedsAttention(SCOPE)).rejects.toThrow('db down');
  });

  it('applies a stored threshold and keeps the defaults for the rest', async () => {
    storedThresholds({ successRatePct: 50 });
    const result = await service.getNeedsAttention(SCOPE) as {
      items: Array<{ findings: Array<{ rule: string }> }>;
      thresholds: NeedsAttentionThresholds;
    };
    // 60% now passes the org's own bar…
    expect(result.items[0]?.findings.map((f) => f.rule) ?? []).not.toContain('low_success_rate');
    // …and the four rules the org did NOT configure keep their defaults, rather than being
    // silently disabled by configuring one.
    expect(result.thresholds).toMatchObject({
      successRatePct: 50,
      p95IncreasePct: 25,
      consecutiveFailures: 3,
      staleDays: 7,
      failureAfterChangeHours: 24,
    });
  });

  it('falls back to every default when the org configured nothing', async () => {
    const result = await service.getNeedsAttention(SCOPE) as { thresholds: NeedsAttentionThresholds };
    expect(result.thresholds.successRatePct).toBe(90);
  });

  it('falls back when the stored value is not an object', async () => {
    mockSelect.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ t: 'nonsense' }]) }) }),
    });
    const result = await service.getNeedsAttention(SCOPE) as { thresholds: NeedsAttentionThresholds };
    expect(result.thresholds.successRatePct).toBe(90);
  });

  it('reports zero evaluated for an org with no pipelines, and flags nothing', async () => {
    getPipelineBreakdown.mockResolvedValue([]);
    const result = await service.getNeedsAttention(SCOPE) as { items: unknown[]; pipelinesEvaluated: number };
    // The distinction the whole section depends on: nothing tripped, versus nothing ran.
    expect(result.items).toEqual([]);
    expect(result.pipelinesEvaluated).toBe(0);
  });

  it('evaluates as of the window END, not now', async () => {
    getPipelineStreaks.mockResolvedValue([
      { pipelineId: 'pipe-1', consecutiveFailures: 0, lastSuccessAt: new Date('2026-09-01T00:00:00Z') },
    ]);
    const result = await service.getNeedsAttention(SCOPE) as {
      items: Array<{ findings: Array<{ rule: string; evidence: string }> }>;
    };
    const stale = result.items[0]?.findings.find((f) => f.rule === 'no_recent_success');
    // 2026-09-01 to the window end (2026-09-21) is 20 days. Measured from `now` this
    // number would change every day a report was re-read, which is the one thing a frozen
    // snapshot must not do.
    expect(stale?.evidence).toContain('20 days ago');
  });
});
