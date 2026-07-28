// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for ReportingService.
 * Mocks the db module and verifies correct SQL template usage.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockExecute = jest.fn();
const mockInsert = jest.fn();
const mockSelect = jest.fn();

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({
  db: {
    execute: mockExecute,
    insert: mockInsert,
    select: mockSelect,
  },
}));

// withTenantTx wraps every reporting query in a tx that SET LOCALs the
// RLS GUCs. For unit tests we mock it to a pass-through invoking the
// callback with the same fake `db` so existing `mockExecute` assertions
// still match without per-test rewrites.
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({
    execute: mockExecute,
    insert: mockInsert,
    select: mockSelect,
  }),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { ReportingService } = await import('../src/api/reporting-service.js');
type ReportingService = InstanceType<typeof ReportingService>;

describe('ReportingService', () => {
  let service: ReportingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ReportingService();
  });

  // Event ingest — persistence boundary (registry-bound tenancy + AWS scrub)

  describe('ingestEvents', () => {
    /**
     * Wire the mocked tx so `ingestEvents` resolves against a registry and
     * captures the exact rows handed to `.values(...)`. Returns the captured
     * insert batch + the `onConflictDoNothing`/`returning` spies so a test can
     * assert idempotency wiring and the scrubbed persisted payload.
     */
    function wireIngest(registryRows: Array<{ pipelineId: string; orgId: string }>) {
      // tx.select({...}).from(...).where(...) → registry rows (awaited directly)
      mockSelect.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(registryRows),
        }),
      });

      let capturedRows: Array<Record<string, unknown>> = [];
      const returning = jest.fn().mockImplementation(() =>
        // echo one inserted row per captured row so `inserted` counts match
        Promise.resolve(capturedRows.map((r) => ({ orgId: r.orgId }))),
      );
      const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
      const values = jest.fn().mockImplementation((rows: Array<Record<string, unknown>>) => {
        capturedRows = rows;
        return { onConflictDoNothing };
      });
      mockInsert.mockReturnValue({ values });

      return { getRows: () => capturedRows, values, onConflictDoNothing, returning };
    }

    it('redacts AWS account ids from detail (incl. ARN account segment) and errorMessage before persisting', async () => {
      const wire = wireIngest([{ pipelineId: 'pl-1', orgId: 'acme' }]);

      const result = await service.ingestEvents([
        {
          pipelineId: 'pl-1',
          eventSource: 'codepipeline',
          eventType: 'ACTION',
          status: 'FAILED',
          executionId: 'exec-9',
          errorMessage: 'Access denied for account 123456789012 in region us-east-1',
          detail: {
            roleArn: 'arn:aws:iam::123456789012:role/deploy',
            accountId: '210987654321',
            nested: { message: 'assumed arn:aws:sts::123456789012:assumed-role/x' },
            durationMs: 1234567890123, // 13-digit ms timestamp — must survive
          },
        },
      ]);

      expect(result).toEqual({ inserted: 1, skipped: 0, unregisteredPipelineIds: [] });

      const [row] = wire.getRows();
      // Tenant binding comes from the registry, never the event.
      expect(row.orgId).toBe('acme');
      expect(row.pipelineId).toBe('pl-1');
      // Free-form fields scrubbed.
      expect(row.errorMessage).toBe('Access denied for account [REDACTED] in region us-east-1');
      expect(row.detail).toEqual({
        roleArn: 'arn:aws:iam::[REDACTED]:role/deploy',
        accountId: '[REDACTED]', // account-named key dropped wholesale
        nested: { message: 'assumed arn:aws:sts::[REDACTED]:assumed-role/x' },
        durationMs: 1234567890123,
      });
      // Idempotency wiring preserved.
      expect(wire.onConflictDoNothing).toHaveBeenCalledTimes(1);
    });

    it('round-trips a clean event unchanged (only account-id-shaped tokens are touched)', async () => {
      const wire = wireIngest([{ pipelineId: 'pl-1', orgId: 'acme' }]);

      const cleanDetail = { pluginName: 'nodejs-build', region: 'us-east-1', attempts: 3 };
      await service.ingestEvents([
        {
          pipelineId: 'pl-1',
          eventSource: 'plugin-build',
          eventType: 'BUILD',
          status: 'failed',
          errorMessage: 'Docker build failed: exit code 1',
          detail: cleanDetail,
        },
      ]);

      const [row] = wire.getRows();
      expect(row.errorMessage).toBe('Docker build failed: exit code 1');
      expect(row.detail).toEqual(cleanDetail);
    });

    it('leaves undefined detail/errorMessage undefined (no scrub applied)', async () => {
      const wire = wireIngest([{ pipelineId: 'pl-1', orgId: 'acme' }]);

      await service.ingestEvents([
        { pipelineId: 'pl-1', eventSource: 'codepipeline', eventType: 'PIPELINE', status: 'SUCCEEDED' },
      ]);

      const [row] = wire.getRows();
      expect(row.errorMessage).toBeUndefined();
      expect(row.detail).toBeUndefined();
    });

    it('skips events for unregistered pipeline ids and does not insert them (tenant binding unchanged)', async () => {
      const wire = wireIngest([{ pipelineId: 'pl-1', orgId: 'acme' }]);

      const result = await service.ingestEvents([
        { pipelineId: 'pl-1', eventSource: 'codepipeline', eventType: 'PIPELINE', status: 'SUCCEEDED' },
        { pipelineId: 'pl-unknown', eventSource: 'codepipeline', eventType: 'PIPELINE', status: 'FAILED' },
      ]);

      expect(result.inserted).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.unregisteredPipelineIds).toEqual(['pl-unknown']);
      // Only the registered event made it into the insert batch.
      const rows = wire.getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].pipelineId).toBe('pl-1');
    });

    it('does not call insert when no events resolve to a registered pipeline', async () => {
      const wire = wireIngest([]);

      const result = await service.ingestEvents([
        { pipelineId: 'pl-unknown', eventSource: 'codepipeline', eventType: 'PIPELINE', status: 'FAILED' },
      ]);

      expect(result).toEqual({ inserted: 0, skipped: 1, unregisteredPipelineIds: ['pl-unknown'] });
      expect(wire.values).not.toHaveBeenCalled();
    });
  });

  // Category 1: Pipeline Execution & Performance

  describe('getExecutionCount', () => {
    it('should return execution counts per pipeline', async () => {
      const mockRows = [
        { id: 'p1', project: 'app', organization: 'acme', pipeline_name: 'acme-app-pipeline', total: 10, succeeded: 8, failed: 2, canceled: 0, first_execution: '2026-01-01', last_execution: '2026-03-01' },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.getExecutionCount('acme');

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockRows);
    });

    it('should return empty array when no executions', async () => {
      mockExecute.mockResolvedValue({ rows: [] });

      const result = await service.getExecutionCount('empty-org');

      expect(result).toEqual([]);
    });

    it('accepts an optional [from,to] window (honors the dashboard date range)', async () => {
      mockExecute.mockResolvedValue({ rows: [] });

      await service.getExecutionCount('acme', undefined, { from: '2026-06-01T00:00:00Z', to: '2026-07-01T00:00:00Z' });

      // The range rides the query; a distinct cache key per window keeps ranged
      // and all-time counts from colliding.
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe('getSuccessRate', () => {
    it('should return time-series success rate', async () => {
      const mockRows = [
        { period: '2026-03-01', succeeded: 5, failed: 1, canceled: 0, success_pct: 83.3 },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.getSuccessRate('acme', 'week', '2026-03-01', '2026-03-15');

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockRows);
    });
  });

  describe('listPipelineExecutions', () => {
    it('returns per-execution rolled-up rows for a pipeline (single query)', async () => {
      // The GROUP BY execution_id + CASE roll-up happens in SQL; the service
      // just maps the driver rows through. One execution rolled up to `failed`
      // with its failing stage surfaced.
      const mockRows = [
        { execution_id: 'exec-2', status: 'failed', started_at: '2026-07-02T10:00:00Z', ended_at: '2026-07-02T10:05:00Z', duration_ms: 300000, failing_stage: 'Deploy', failing_action: 'Terraform' },
        { execution_id: 'exec-1', status: 'succeeded', started_at: '2026-07-01T10:00:00Z', ended_at: '2026-07-01T10:03:00Z', duration_ms: 180000, failing_stage: null, failing_action: null },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.listPipelineExecutions('acme', 'p1');

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockRows);
    });

    it('runs a rollup (multi-org) read under sysadmin context when given an org subtree', async () => {
      // With orgIds spanning the org→team subtree the query uses an IN (...)
      // predicate; passing only the subtree ids is how cross-org executions are
      // excluded. runWithTenantContext is mocked to pass-through, so we just
      // assert the query still fires with the rollup arg.
      mockExecute.mockResolvedValue({ rows: [] });

      const result = await service.listPipelineExecutions('acme', 'p1', ['acme', 'team-child'], { from: '2026-06-01', to: '2026-07-01' }, 10);

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result).toEqual([]);
    });
  });

  describe('getAverageDuration', () => {
    it('should return duration stats per pipeline', async () => {
      const mockRows = [
        { id: 'p1', project: 'app', pipeline_name: 'acme-app', avg_ms: 120000, min_ms: 60000, max_ms: 300000, p95_ms: 250000, executions: 20 },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.getAverageDuration('acme', '2026-01-01', '2026-03-15');

      expect(result).toEqual(mockRows);
    });
  });

  describe('getStageFailures', () => {
    it('should return stage failure heatmap', async () => {
      const mockRows = [
        { stage_name: 'Build', failures: 5, total: 20, failure_pct: 25.0 },
        { stage_name: 'Test', failures: 2, total: 18, failure_pct: 11.1 },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.getStageFailures('acme', '2026-01-01', '2026-03-15');

      expect(result).toHaveLength(2);
    });
  });

  describe('getStageBottlenecks', () => {
    it('should return slowest stages', async () => {
      const mockRows = [
        { id: 'p1', pipeline_name: 'acme-app', stage_name: 'Deploy', avg_ms: 300000, max_ms: 600000 },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.getStageBottlenecks('acme', '2026-01-01', '2026-03-15');

      expect(result).toEqual(mockRows);
    });
  });

  describe('getActionFailures', () => {
    it('should return action failure rates', async () => {
      const mockRows = [
        { action_name: 'nodejs-build', failures: 3, total: 15, failure_pct: 20.0 },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.getActionFailures('acme', '2026-01-01', '2026-03-15');

      expect(result).toEqual(mockRows);
    });
  });

  describe('getErrors', () => {
    it('should return categorized errors with limit', async () => {
      const mockRows = [
        { error_pattern: 'npm ERR! code ELIFECYCLE', occurrences: 5, affected_pipelines: 2, last_seen: '2026-03-10' },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.getErrors('acme', '2026-01-01', '2026-03-15', 10);

      expect(result).toEqual(mockRows);
    });

    it('should default to 20 results', async () => {
      mockExecute.mockResolvedValue({ rows: [] });

      await service.getErrors('acme', '2026-01-01', '2026-03-15');

      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe('getDoraMetrics', () => {
    // The service issues ONE aggregate query returning a single row (all four
    // DORA metrics rolled up in SQL) and shapes it in JS. We assert the JS
    // shaping: perDay from the window, CFR pct = failed/(succeeded+failed),
    // MTTR avgSeconds from the recovery gap, and the lead-time median.
    const FROM = '2026-07-01T00:00:00Z';
    const TO = '2026-07-11T00:00:00Z'; // 10-day window

    it('shapes the four DORA metrics from the aggregate row', async () => {
      // 8 successful deploys over 10 days → 0.8/day; 2 failed of 10 terminal
      // (succeeded+failed) → CFR 20.0%; one restore gap of 300s; median run
      // time 180000ms → 180s.
      mockExecute.mockResolvedValue({
        rows: [{
          df_deployments: 8,
          cfr_failed: 2,
          cfr_total: 10,
          lt_deployments: 8,
          lt_median_ms: 180000,
          mttr_failures: 2,
          mttr_restored: 1,
          mttr_avg_seconds: 300,
        }],
      });

      const result = await service.getDoraMetrics('acme', FROM, TO);

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        window: { from: FROM, to: TO },
        basis: 'run',
        filters: { pipelineId: null, environment: null },
        deploymentFrequency: { deployments: 8, perDay: 0.8, level: 'high' },
        changeFailureRate: { failed: 2, total: 10, pct: 20.0, level: 'low' },
        meanTimeToRestore: { failures: 2, restored: 1, avgSeconds: 300, level: 'elite' },
        leadTime: { deployments: 8, medianSeconds: 180, approx: true, level: 'elite' },
      });
    });

    it('returns null MTTR/lead-time and zero CFR when there is no activity', async () => {
      // Empty window: COUNT→0, PERCENTILE/AVG→null. avgSeconds null (no
      // failures), medianSeconds null (no successes), CFR pct 0 (no divide).
      mockExecute.mockResolvedValue({
        rows: [{
          df_deployments: 0,
          cfr_failed: 0,
          cfr_total: 0,
          lt_deployments: 0,
          lt_median_ms: null,
          mttr_failures: 0,
          mttr_restored: 0,
          mttr_avg_seconds: null,
        }],
      });

      const result = await service.getDoraMetrics('acme', FROM, TO);

      expect(result).toEqual({
        window: { from: FROM, to: TO },
        basis: 'run',
        filters: { pipelineId: null, environment: null },
        deploymentFrequency: { deployments: 0, perDay: 0, level: null },
        changeFailureRate: { failed: 0, total: 0, pct: 0, level: null },
        meanTimeToRestore: { failures: 0, restored: 0, avgSeconds: null, level: null },
        leadTime: { deployments: 0, medianSeconds: null, approx: true, level: null },
      });
    });

    it('runs a rollup (multi-org) read when given an org subtree', async () => {
      mockExecute.mockResolvedValue({
        rows: [{
          df_deployments: 1,
          cfr_failed: 0,
          cfr_total: 1,
          lt_deployments: 1,
          lt_median_ms: 60000,
          mttr_failures: 0,
          mttr_restored: 0,
          mttr_avg_seconds: null,
        }],
      });

      const result = await service.getDoraMetrics('acme', FROM, TO, ['acme', 'team-child']);

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.deploymentFrequency.deployments).toBe(1);
      expect(result.leadTime.medianSeconds).toBe(60);
    });

    it('floors a same-day window at one day so perDay is the count, not an extrapolation', async () => {
      // from == to (a single calendar day passed as date-only strings): the
      // divisor floors at 1 day, so 5 deploys → 5/day (not /0 and not raw count
      // mislabeled as a rate).
      mockExecute.mockResolvedValue({
        rows: [{
          df_deployments: 5,
          cfr_failed: 0,
          cfr_total: 5,
          lt_deployments: 5,
          lt_median_ms: 60000,
          mttr_failures: 0,
          mttr_restored: 0,
          mttr_avg_seconds: null,
        }],
      });

      const result = await service.getDoraMetrics('acme', '2026-07-01', '2026-07-01');

      expect(result.deploymentFrequency).toEqual({ deployments: 5, perDay: 5, level: 'elite' });
    });

    it('reports basis=deploy and echoes filters when scoped to an environment', async () => {
      mockExecute.mockResolvedValue({
        rows: [{
          df_deployments: 3,
          cfr_failed: 0,
          cfr_total: 3,
          lt_deployments: 3,
          lt_median_ms: 60000,
          mttr_failures: 0,
          mttr_restored: 0,
          mttr_avg_seconds: null,
        }],
      });

      const result = await service.getDoraMetrics('acme', FROM, TO, undefined, {
        environment: 'production',
        pipelineId: 'p-1',
      });

      expect(result.basis).toBe('deploy');
      expect(result.filters).toEqual({ pipelineId: 'p-1', environment: 'production' });
    });

    it('reports basis=deploy for deploysOnly (any environment)', async () => {
      mockExecute.mockResolvedValue({
        rows: [{
          df_deployments: 0,
          cfr_failed: 0,
          cfr_total: 0,
          lt_deployments: 0,
          lt_median_ms: null,
          mttr_failures: 0,
          mttr_restored: 0,
          mttr_avg_seconds: null,
        }],
      });

      const result = await service.getDoraMetrics('acme', FROM, TO, undefined, { deploysOnly: true });

      expect(result.basis).toBe('deploy');
      expect(result.filters).toEqual({ pipelineId: null, environment: null });
    });

    it('bands on the UNROUNDED rate at the monthly boundary (1 deploy / 30 days → medium, not low)', async () => {
      // perDay = 1/30 = 0.0333…; rounding to 0.03 before banding would fail the
      // `>= 1/30` medium check and mislabel it "low". Regression for that bug.
      mockExecute.mockResolvedValue({
        rows: [{
          df_deployments: 1,
          cfr_failed: 0,
          cfr_total: 1,
          lt_deployments: 1,
          lt_median_ms: 60000,
          mttr_failures: 0,
          mttr_restored: 0,
          mttr_avg_seconds: null,
        }],
      });

      // 30-day window (FROM=2026-07-01 .. TO=2026-07-31).
      const result = await service.getDoraMetrics('acme', '2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z');

      expect(result.deploymentFrequency.perDay).toBe(0.03); // display still rounded
      expect(result.deploymentFrequency.level).toBe('medium'); // banded on 0.0333…
    });
  });

  describe('getDoraTrend', () => {
    it('returns per-bucket deployment + change-failure points', async () => {
      mockExecute.mockResolvedValue({
        rows: [
          { period: '2026-07-01', deployments: 4, failed: 1, total: 5, changeFailurePct: 20 },
          { period: '2026-07-02', deployments: 6, failed: 0, total: 6, changeFailurePct: 0 },
        ],
      });

      const result = await service.getDoraTrend('acme', 'day', '2026-07-01', '2026-07-03');

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ period: '2026-07-01', deployments: 4, changeFailurePct: 20 });
    });
  });

  // DORA generated-SQL coverage
  //
  // TEST-PATH NOTE: these pin the QUERY CONSTRUCTION rather than executing it
  // against a real Postgres. A real/in-memory DB harness is NOT cleanly feasible
  // in this jest-ESM setup: pg-mem is not installed (and package.json here is
  // projen-generated, so adding a devDep + wiring drizzle's node-postgres driver
  // is exactly the infra fight the task says to avoid), and pg-mem does not
  // implement the aggregate machinery these queries lean on — PERCENTILE_CONT
  // WITHIN GROUP (lead-time median), FILTER clauses, and interval arithmetic —
  // so the DORA CTEs could not run there anyway. Instead we render the exact SQL
  // handed to `tx.execute` (via drizzle's PgDialect) and assert the load-bearing
  // fragments: the STOPPED status set, the MTTR look-ahead interval, the
  // end-based recovery selection + the incident_started guard from the negative-
  // gap fix, the incident GROUP BY, and the deploy/pipeline scope predicates.
  // This locks the two DORA methods to the shared `execsCte` (no status-set /
  // predicate drift) and guards the Change 1 semantics at the SQL level.
  describe('DORA generated SQL', () => {
    const dialect = new PgDialect();
    /** Render the SQL object captured by the Nth `tx.execute` call to text+params. */
    function rendered(callIndex = 0): { sql: string; params: unknown[] } {
      const arg = mockExecute.mock.calls[callIndex]?.[0] as SQL | undefined;
      if (!arg) throw new Error('tx.execute was not called');
      const { sql, params } = dialect.sqlToQuery(arg);
      return { sql, params };
    }

    const FROM = '2026-07-01T00:00:00Z';
    const TO = '2026-07-11T00:00:00Z';

    it('getDoraMetrics: STOPPED status set, MTTR look-ahead, end-based restore + incident collapse/guard', async () => {
      mockExecute.mockResolvedValue({ rows: [{}] });
      await service.getDoraMetrics('acme', FROM, TO);

      const { sql, params } = rendered();
      // Shared terminal status set (STOPPED joins the ELSE/CANCELED bucket).
      expect(sql).toContain("e.status IN ('SUCCEEDED', 'FAILED', 'CANCELED', 'STOPPED')");
      // Look-ahead tail: the 30-day interval is bound as a param + cast ::interval.
      expect(sql).toContain('::interval');
      expect(params).toContain('30 days');
      // Change 1: recovery is selected AND measured on ended_at (no started_at
      // selection that could yield a negative gap).
      expect(sql).toContain('s.ended_at > f.ended_at');
      expect(sql).toContain('ORDER BY s.ended_at ASC');
      expect(sql).not.toContain('s.started_at > f.started_at');
      // Change 1: `restored` is guarded so it can't exceed measured incidents.
      expect(sql).toContain('incident_started IS NOT NULL');
      // Incident collapse GROUP BY (consecutive failures → one incident).
      expect(sql).toContain('GROUP BY pipeline_id, restored_at');
      // Unscoped ⇒ no per-pipeline / environment predicate.
      expect(sql).not.toContain('e.pipeline_id =');
      expect(sql).not.toContain('e.environment');
    });

    it('getDoraMetrics: env + pipeline scoping filters BOTH the metrics AND the MTTR recovery scan', async () => {
      mockExecute.mockResolvedValue({ rows: [{}] });
      await service.getDoraMetrics('acme', FROM, TO, undefined, {
        environment: 'production',
        pipelineId: 'p-1',
      });

      const { sql, params } = rendered();
      // Both scope clauses live INSIDE the single `execs` CTE, so the failure
      // rows and their recovery-success candidates (drawn from the same execs)
      // are filtered identically — a foreign-env success can't "restore" a
      // scoped failure.
      expect(sql).toContain('e.pipeline_id =');
      expect(sql).toContain('e.environment =');
      expect(params).toContain('p-1');
      expect(params).toContain('production');
      // execs is the only table scan (restore's subquery reads from execs, not
      // a second pipeline_event scan), so there is exactly one WHERE on org_id.
      expect(sql.match(/e\.environment =/g) ?? []).toHaveLength(1);
    });

    it('getDoraMetrics: deploysOnly scopes to any tagged environment', async () => {
      mockExecute.mockResolvedValue({ rows: [{}] });
      await service.getDoraMetrics('acme', FROM, TO, undefined, { deploysOnly: true });

      const { sql } = rendered();
      expect(sql).toContain('e.environment IS NOT NULL');
      expect(sql).not.toContain('e.environment =');
    });

    it('getDoraTrend: shares the execs status set but has NO MTTR look-ahead', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getDoraTrend('acme', 'day', FROM, TO);

      const { sql, params } = rendered();
      expect(sql).toContain("e.status IN ('SUCCEEDED', 'FAILED', 'CANCELED', 'STOPPED')");
      expect(sql).toContain('GROUP BY e.execution_id, e.pipeline_id');
      // Trend buckets the core window only — no look-ahead tail, no restore CTE.
      expect(sql).not.toContain('::interval');
      expect(params).not.toContain('30 days');
      expect(sql).not.toContain('restored_at');
    });

    it('getDoraTrend: env + pipeline scoping applied to the shared execs CTE', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getDoraTrend('acme', 'day', FROM, TO, undefined, {
        environment: 'staging',
        pipelineId: 'p-9',
      });

      const { sql, params } = rendered();
      expect(sql).toContain('e.pipeline_id =');
      expect(sql).toContain('e.environment =');
      expect(params).toContain('p-9');
      expect(params).toContain('staging');
    });

    it('both DORA methods emit the identical execs status set (no drift via execsCte)', async () => {
      mockExecute.mockResolvedValue({ rows: [{}] });
      await service.getDoraMetrics('acme', FROM, TO);
      const metricsSql = rendered(0).sql;

      jest.clearAllMocks();
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getDoraTrend('acme', 'day', FROM, TO);
      const trendSql = rendered(0).sql;

      const statusSet = "e.status IN ('SUCCEEDED', 'FAILED', 'CANCELED', 'STOPPED')";
      expect(metricsSql).toContain(statusSet);
      expect(trendSql).toContain(statusSet);
    });
  });

  // Category 2: Plugin Inventory & Builds

  describe('getPluginSummary', () => {
    it('should return plugin counts', async () => {
      const mockRow = { total: 10, active: 8, inactive: 2, public: 3, private: 7, unique_names: 5 };
      mockExecute.mockResolvedValue({ rows: [mockRow] });

      const result = await service.getPluginSummary('acme');

      expect(result).toEqual(mockRow);
    });

    it('should return zeros when no plugins', async () => {
      mockExecute.mockResolvedValue({ rows: [] });

      const result = await service.getPluginSummary('empty-org');

      expect(result.total).toBe(0);
    });
  });

  describe('getPluginDistribution', () => {
    it('should return type/compute distribution', async () => {
      const mockRows = [
        { plugin_type: 'CodeBuildStep', compute_type: 'SMALL', count: 5 },
        { plugin_type: 'ShellStep', compute_type: 'MEDIUM', count: 2 },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.getPluginDistribution('acme');

      expect(result).toHaveLength(2);
    });
  });

  describe('getPluginVersions', () => {
    it('should return version counts per plugin', async () => {
      const mockRows = [
        { name: 'nodejs-build', version_count: 3, latest_version: '1.2.0', has_default: true },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.getPluginVersions('acme');

      expect(result).toEqual(mockRows);
    });
  });

  describe('getBuildSuccessRate', () => {
    it('should return build success rate over time', async () => {
      const mockRows = [
        { period: '2026-03-01', succeeded: 8, failed: 2, success_pct: 80.0 },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.getBuildSuccessRate('acme', 'week', '2026-01-01', '2026-03-15');

      expect(result).toEqual(mockRows);
    });
  });

  describe('getBuildDuration', () => {
    it('should return build duration per plugin', async () => {
      const mockRows = [
        { plugin_name: 'nodejs-build', avg_ms: 45000, max_ms: 120000, builds: 10 },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.getBuildDuration('acme', '2026-01-01', '2026-03-15');

      expect(result).toEqual(mockRows);
    });
  });

  describe('getBuildFailures', () => {
    it('should return build failure details', async () => {
      const mockRows = [
        { plugin_name: 'python-test', error_message: 'Docker build failed', occurrences: 3, last_seen: '2026-03-12' },
      ];
      mockExecute.mockResolvedValue({ rows: mockRows });

      const result = await service.getBuildFailures('acme', '2026-01-01', '2026-03-15');

      expect(result).toEqual(mockRows);
    });
  });
});
