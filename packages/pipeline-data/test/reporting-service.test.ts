// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for ReportingService.
 * Mocks the db module and verifies correct SQL template usage.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { apiCoreMock, cacheKeyLog } from './helpers/mock-api-core.js';

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

const { ReportingService, resolveEventRetentionDays, resolveDoraRetentionDays, retentionCutoff } =
  await import('../src/api/reporting-service.js');
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

    it('persists commit_timestamp/commit_count and emits a deploy metric for a terminal deploy stage', async () => {
      const wire = wireIngest([{ pipelineId: 'pl-1', orgId: 'acme' }]);
      const metrics: unknown[] = [];

      await service.ingestEvents([
        {
          pipelineId: 'pl-1', eventSource: 'codepipeline', eventType: 'STAGE', status: 'SUCCEEDED',
          executionId: 'e1', stageName: 'Deploy-prod', environment: 'production',
          commitTimestamp: '2026-07-02T00:00:00Z', commitCount: 3,
        },
      ], (m) => metrics.push(m));

      const [row] = wire.getRows();
      // New Phase-4 lead-time columns persist (as Date / int, not scrubbed).
      expect(row.commitTimestamp).toEqual(new Date('2026-07-02T00:00:00Z'));
      expect(row.commitCount).toBe(3);
      // Phase 3b: one metric emitted for the terminal deploy-stage event, with
      // the registry-resolved org (never the caller's claimed org).
      expect(metrics).toEqual([
        { pipelineId: 'pl-1', orgId: 'acme', stage: 'Deploy-prod', environment: 'production', result: 'succeeded' },
      ]);
    });

    it('does not emit a stage metric for non-terminal or non-STAGE events', async () => {
      wireIngest([{ pipelineId: 'pl-1', orgId: 'acme' }]);
      const metrics: unknown[] = [];

      await service.ingestEvents([
        { pipelineId: 'pl-1', eventSource: 'codepipeline', eventType: 'PIPELINE', status: 'SUCCEEDED', executionId: 'e1' },
        { pipelineId: 'pl-1', eventSource: 'codepipeline', eventType: 'STAGE', status: 'STARTED', executionId: 'e1', stageName: 'Build' },
      ], (m) => metrics.push(m));

      expect(metrics).toEqual([]);
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

    it('rejects an invalid interval before touching the DB (defense-in-depth guard)', async () => {
      // The route (parseReportInterval) is the boundary, but the service asserts
      // the DATE_TRUNC interval too so a bypassing caller fails fast with a clear
      // error instead of a raw Postgres error.
      await expect(
        service.getSuccessRate('acme', 'hour', '2026-03-01', '2026-03-15'),
      ).rejects.toThrow('Invalid report interval');
      expect(mockExecute).not.toHaveBeenCalled();
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

  // DORA is now DEPLOY-BASIS ONLY. getDoraMetrics issues four scoped scans per
  // call, in this order: (0) terminal deploy-stage rows, (1) deployment_outcomes
  // in-window, (2) production restored/failed outcomes for MTTR, (3) coverage.
  // These golden-dataset fixtures feed those four result sets and PROVE each
  // metric's JS math (freq / measured lead / two-class CFR / real MTTR /
  // coverage). The run-basis frequency, lead-time proxy, and inferred CFR/MTTR
  // are gone — no test asserts them any more.
  describe('getDoraMetrics (deploy-basis golden datasets)', () => {
    const FROM = '2026-07-01T00:00:00Z';
    const TO = '2026-07-11T00:00:00Z'; // 10-day window

    /** Queue the five scan results in the order getDoraMetrics reads them:
     *  0=deploy, 1=outcomes, 2=mttr, 3=coverage, 4=incidents (Phase 5). */
    function wireScans(deploy: unknown[], outcomes: unknown[], mttr: unknown[], coverage: unknown[], incidents: unknown[] = []) {
      mockExecute
        .mockResolvedValueOnce({ rows: deploy })
        .mockResolvedValueOnce({ rows: outcomes })
        .mockResolvedValueOnce({ rows: mttr })
        .mockResolvedValueOnce({ rows: coverage })
        .mockResolvedValueOnce({ rows: incidents });
    }

    it('computes DF, two-class CFR, measured lead time, per-env — plus MTTR and coverage', async () => {
      wireScans(
        [
          // production: 3 succeeded (two with commit times → lead 600s + 3600s),
          // 1 failed. attempts = 4.
          { environment: 'production', status: 'SUCCEEDED', completed_at: '2026-07-02T00:10:00Z', commit_ts: '2026-07-02T00:00:00Z' },
          { environment: 'production', status: 'SUCCEEDED', completed_at: '2026-07-03T01:00:00Z', commit_ts: '2026-07-03T00:00:00Z' },
          { environment: 'production', status: 'SUCCEEDED', completed_at: '2026-07-04T00:00:00Z', commit_ts: null },
          { environment: 'production', status: 'FAILED', completed_at: '2026-07-05T00:00:00Z', commit_ts: null },
          // staging: 1 succeeded.
          { environment: 'staging', status: 'SUCCEEDED', completed_at: '2026-07-02T00:00:00Z', commit_ts: null },
        ],
        [
          { environment: 'production', outcome: 'failed' },   // post-deploy failure
          { environment: 'production', outcome: 'restored' },
          { environment: 'staging', outcome: 'failed' },
        ],
        [
          { outcome: 'failed', restored_at: '2026-07-05T00:00:00Z', deployed_at: null },
          { outcome: 'restored', restored_at: '2026-07-06T01:00:00Z', deployed_at: '2026-07-06T00:00:00Z' }, // 3600s
        ],
        [{ registered: 5, deploying: 2 }],
      );

      const result = await service.getDoraMetrics('acme', FROM, TO);

      expect(mockExecute).toHaveBeenCalledTimes(5);
      expect(result.headline).toBe('production');
      expect(result.filters).toEqual({ pipelineId: null, environment: null });
      // Headline (production) is first.
      expect(result.environments.map((e) => e.environment)).toEqual(['production', 'staging']);

      const prod = result.environments[0];
      // Deployment Frequency: 3 successful deploys over 10 days → 0.3/day (high).
      expect(prod.deploymentFrequency).toEqual({ deployments: 3, perDay: 0.3, level: 'high' });
      // Two-class CFR: (1 deploy-time + 1 post-deploy) / 4 attempts = 50%.
      expect(prod.changeFailureRate).toEqual({
        rate: 50, deployTimeFailures: 1, postDeployFailures: 1, attempts: 4, level: 'low',
      });
      // Measured lead time: median(600s, 3600s) = 2100s (elite). Sample = 2.
      expect(prod.leadTime).toEqual({ deployments: 2, medianSeconds: 2100, level: 'elite' });

      const stg = result.environments[1];
      expect(stg.deploymentFrequency).toEqual({ deployments: 1, perDay: 0.1, level: 'medium' });
      expect(stg.changeFailureRate).toEqual({
        rate: 100, deployTimeFailures: 0, postDeployFailures: 1, attempts: 1, level: 'low',
      });
      // No commit timestamps in staging → lead time unknown.
      expect(stg.leadTime).toEqual({ deployments: 0, medianSeconds: null, level: null });

      // MTTR (production-only): 1 incident, 1 restored, median gap 3600s (high).
      expect(result.meanTimeToRestore).toEqual({ incidents: 1, restored: 1, medianSeconds: 3600, level: 'high' });

      // Coverage: 5 registered, 2 deploying → 3 without deploys.
      expect(result.coverage).toEqual({ registered: 5, deploying: 2, withoutDeploys: 3 });
    });

    it('returns an empty panel (no envs, null MTTR, coverage) when nothing deployed', async () => {
      wireScans([], [], [], [{ registered: 2, deploying: 0 }]);

      const result = await service.getDoraMetrics('acme', FROM, TO);

      expect(result.environments).toEqual([]);
      expect(result.meanTimeToRestore).toEqual({ incidents: 0, restored: 0, medianSeconds: null, level: null });
      expect(result.coverage).toEqual({ registered: 2, deploying: 0, withoutDeploys: 2 });
    });

    it('surfaces an env from post-deploy outcomes even with no in-window deploy events', async () => {
      // A prod deploy from before the window is marked failed now: the env still
      // appears with attempts=0 (CFR level null — nothing to judge).
      wireScans([], [{ environment: 'production', outcome: 'failed' }], [], [{ registered: 1, deploying: 0 }]);

      const result = await service.getDoraMetrics('acme', FROM, TO);

      expect(result.environments).toHaveLength(1);
      const prod = result.environments[0];
      expect(prod.changeFailureRate).toEqual({
        rate: 0, deployTimeFailures: 0, postDeployFailures: 1, attempts: 0, level: null,
      });
      expect(prod.deploymentFrequency.deployments).toBe(0);
    });

    it('clamps a negative MTTR gap to zero (restored before the recorded deploy time)', async () => {
      wireScans(
        [{ environment: 'production', status: 'SUCCEEDED', completed_at: '2026-07-02T00:00:00Z', commit_ts: null }],
        [],
        [{ outcome: 'restored', restored_at: '2026-07-06T00:00:00Z', deployed_at: '2026-07-06T01:00:00Z' }], // -3600s
        [{ registered: 1, deploying: 1 }],
      );

      const result = await service.getDoraMetrics('acme', FROM, TO);

      expect(result.meanTimeToRestore.medianSeconds).toBe(0);
      expect(result.meanTimeToRestore.restored).toBe(1);
    });

    it('clamps a negative lead-time delta to zero (commit after deploy — clock skew)', async () => {
      wireScans(
        [{ environment: 'production', status: 'SUCCEEDED', completed_at: '2026-07-02T00:00:00Z', commit_ts: '2026-07-02T01:00:00Z' }],
        [], [], [{ registered: 1, deploying: 1 }],
      );

      const result = await service.getDoraMetrics('acme', FROM, TO);

      expect(result.environments[0].leadTime).toEqual({ deployments: 1, medianSeconds: 0, level: 'elite' });
    });

    it('runs a rollup (multi-org) read when given an org subtree', async () => {
      wireScans(
        [{ environment: 'production', status: 'SUCCEEDED', completed_at: '2026-07-02T00:00:00Z', commit_ts: null }],
        [], [], [{ registered: 3, deploying: 1 }],
      );

      const result = await service.getDoraMetrics('acme', FROM, TO, ['acme', 'team-child']);

      expect(result.environments[0].deploymentFrequency.deployments).toBe(1);
      expect(result.coverage.deploying).toBe(1);
    });

    it('echoes the environment/pipeline filters', async () => {
      wireScans([], [], [], [{ registered: 0, deploying: 0 }]);

      const result = await service.getDoraMetrics('acme', FROM, TO, undefined, {
        environment: 'production', pipelineId: 'p-1',
      });

      expect(result.filters).toEqual({ pipelineId: 'p-1', environment: 'production' });
    });
  });

  // Phase 5 — webhook-ingested incidents correlate to the most recent successful
  // deploy → automated post-deploy CFR + real MTTR. These golden fixtures prove
  // the JS correlation math: window boundary, dedup vs a manual outcome on the
  // same deploy, and the incident-precedence recovery time.
  describe('getDoraMetrics — incident correlation (Phase 5)', () => {
    const FROM = '2026-07-01T00:00:00Z';
    const TO = '2026-07-11T00:00:00Z';

    function wireScans(deploy: unknown[], outcomes: unknown[], mttr: unknown[], coverage: unknown[], incidents: unknown[]) {
      mockExecute
        .mockResolvedValueOnce({ rows: deploy })
        .mockResolvedValueOnce({ rows: outcomes })
        .mockResolvedValueOnce({ rows: mttr })
        .mockResolvedValueOnce({ rows: coverage })
        .mockResolvedValueOnce({ rows: incidents });
    }

    // One successful production deploy the incidents can attribute to.
    const prodDeploy = { environment: 'production', execution_id: 'exec-A', status: 'SUCCEEDED', completed_at: '2026-07-02T00:00:00Z', commit_ts: null };

    it('correlates an in-window incident → post-deploy failure (CFR) + real MTTR (resolved−opened)', async () => {
      wireScans(
        [prodDeploy],
        [], [],
        [{ registered: 1, deploying: 1 }],
        // Opened 2h after the deploy completed (well within 24h); resolved 1h later.
        [{ environment: 'production', opened_at: '2026-07-02T02:00:00Z', resolved_at: '2026-07-02T03:00:00Z' }],
      );

      const result = await service.getDoraMetrics('acme', FROM, TO);

      const prod = result.environments[0];
      // The successful deploy is now a post-deploy failure via the incident.
      expect(prod.changeFailureRate).toEqual({
        rate: 100, deployTimeFailures: 0, postDeployFailures: 1, attempts: 1, level: 'low',
      });
      // Real MTTR = resolved_at − opened_at = 3600s (not a manual restored−deployed).
      expect(result.meanTimeToRestore).toEqual({ incidents: 1, restored: 1, medianSeconds: 3600, level: 'high' });
    });

    it('correlates at the exact window boundary (24h) but NOT one second past it', async () => {
      // Boundary-inclusive: an incident opened exactly 24h after the deploy correlates.
      wireScans(
        [prodDeploy], [], [], [{ registered: 1, deploying: 1 }],
        [{ environment: 'production', opened_at: '2026-07-03T00:00:00Z', resolved_at: null }],
      );
      const atBoundary = await service.getDoraMetrics('acme', FROM, TO);
      expect(atBoundary.environments[0].changeFailureRate.postDeployFailures).toBe(1);

      jest.clearAllMocks();

      // One second past 24h: no eligible deploy → not attributable, no CFR impact.
      wireScans(
        [prodDeploy], [], [], [{ registered: 1, deploying: 1 }],
        [{ environment: 'production', opened_at: '2026-07-03T00:00:01Z', resolved_at: null }],
      );
      const pastBoundary = await service.getDoraMetrics('acme', FROM, TO);
      expect(pastBoundary.environments[0].changeFailureRate.postDeployFailures).toBe(0);
      // Uncorrelated incident contributes nothing to MTTR either.
      expect(pastBoundary.meanTimeToRestore).toEqual({ incidents: 0, restored: 0, medianSeconds: null, level: null });
    });

    it('dedups an incident against a manual failed outcome on the SAME deploy (counts once)', async () => {
      wireScans(
        [prodDeploy],
        // Manual failed outcome on exec-A (Phase 2).
        [{ environment: 'production', outcome: 'failed', execution_id: 'exec-A' }],
        // Manual failed also surfaces in the production MTTR scan for exec-A.
        [{ outcome: 'failed', execution_id: 'exec-A', restored_at: '2026-07-02T05:00:00Z', deployed_at: null }],
        [{ registered: 1, deploying: 1 }],
        // Incident ALSO correlates to exec-A (2h recovery), resolved.
        [{ environment: 'production', opened_at: '2026-07-02T02:00:00Z', resolved_at: '2026-07-02T04:00:00Z' }],
      );

      const result = await service.getDoraMetrics('acme', FROM, TO);

      // exec-A flagged by both a manual failure AND an incident → ONE post-deploy failure.
      expect(result.environments[0].changeFailureRate.postDeployFailures).toBe(1);
      // Incident takes precedence for MTTR: 1 incident, resolved gap = 7200s (not
      // the manual failed marker double-counting it).
      expect(result.meanTimeToRestore).toEqual({ incidents: 1, restored: 1, medianSeconds: 7200, level: 'high' });
    });

    it('adds a 6th (incidents) scan and reads it last', async () => {
      wireScans([], [], [], [{ registered: 0, deploying: 0 }], []);
      await service.getDoraMetrics('acme', FROM, TO);
      // 0=deploy,1=outcomes,2=mttr,3=coverage,4=incidents
      expect(mockExecute).toHaveBeenCalledTimes(5);
    });

    it('incident scan queries the incidents table over the opened_at window', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getDoraMetrics('acme', FROM, TO);
      const dialect = new PgDialect();
      const arg = mockExecute.mock.calls[4]?.[0] as SQL; // 5th scan = incidents
      const { sql } = dialect.sqlToQuery(arg);
      expect(sql).toContain('incidents');
      expect(sql).toContain('i.opened_at');
    });

    // Phase 5b — a per-org correlation-window override (threaded via
    // DoraOptions.incidentWindowHours) changes which deploy an incident attributes
    // to. Same fixture, two windows: default 24h correlates; a 1h override does not.
    it('respects a per-org incident window override in correlation', async () => {
      // Incident opens 2h after the deploy completed.
      const incident = [{ environment: 'production', opened_at: '2026-07-02T02:00:00Z', resolved_at: null }];

      // Default window (24h): the 2h-old deploy correlates → post-deploy failure.
      wireScans([prodDeploy], [], [], [{ registered: 1, deploying: 1 }], incident);
      const wide = await service.getDoraMetrics('acme', FROM, TO);
      expect(wide.environments[0].changeFailureRate.postDeployFailures).toBe(1);

      jest.clearAllMocks();

      // 1h override: 2h is outside the window → NOT attributable, no CFR impact.
      wireScans([prodDeploy], [], [], [{ registered: 1, deploying: 1 }], incident);
      const narrow = await service.getDoraMetrics('acme', FROM, TO, undefined, { incidentWindowHours: 1 });
      expect(narrow.environments[0].changeFailureRate.postDeployFailures).toBe(0);
      expect(narrow.meanTimeToRestore).toEqual({ incidents: 0, restored: 0, medianSeconds: null, level: null });
    });
  });

  // DORA compute survey fixes: per-execution DF (D1), lead-time via the PIPELINE
  // event's commit ts (D2), correlation look-back to `from − windowHours`, MTTR
  // right-censoring at `to`, cache-key window inclusion, and exact band edges.
  describe('getDoraMetrics — compute survey fixes', () => {
    const FROM = '2026-07-01T00:00:00Z';
    const TO = '2026-07-11T00:00:00Z';
    const dialect = new PgDialect();

    function wireScans(deploy: unknown[], outcomes: unknown[], mttr: unknown[], coverage: unknown[], incidents: unknown[] = []) {
      mockExecute
        .mockResolvedValueOnce({ rows: deploy })
        .mockResolvedValueOnce({ rows: outcomes })
        .mockResolvedValueOnce({ rows: mttr })
        .mockResolvedValueOnce({ rows: coverage })
        .mockResolvedValueOnce({ rows: incidents });
    }

    // D1 — the deploy scan groups per (environment, execution), so two deploy
    // STAGE rows of ONE execution collapse to a SINGLE deployment row. Proven at
    // the SQL layer (JS receives post-grouping rows); one grouped row → 1 deploy.
    it('D1: deploy scan groups per (env, execution), not per stage', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getDoraMetrics('acme', FROM, TO);
      const { sql } = dialect.sqlToQuery(mockExecute.mock.calls[0]?.[0] as SQL);
      expect(sql).toContain('GROUP BY e.environment, e.execution_id');
      expect(sql).not.toContain('stage_name');
    });

    it('D1: one per-execution deploy row (two stages already rolled up) counts as 1 deployment', async () => {
      wireScans(
        [{ environment: 'production', execution_id: 'exec-1', status: 'SUCCEEDED', completed_at: '2026-07-02T00:00:00Z', commit_ts: null, in_window: true }],
        [], [], [{ registered: 1, deploying: 1 }],
      );
      const result = await service.getDoraMetrics('acme', FROM, TO);
      expect(result.environments[0].deploymentFrequency.deployments).toBe(1);
      expect(result.environments[0].changeFailureRate.attempts).toBe(1);
    });

    // D2 — commit time rides the PIPELINE/source event (environment IS NULL), so
    // the deploy scan joins the execution's EARLIEST commit across ALL its events
    // via a dedicated exec_commits CTE (not the STAGE row's own commit column).
    it('D2: commit time joins the execution\'s earliest commit via exec_commits (any event type)', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getDoraMetrics('acme', FROM, TO);
      const { sql } = dialect.sqlToQuery(mockExecute.mock.calls[0]?.[0] as SQL);
      expect(sql).toContain('exec_commits');
      expect(sql).toContain('MIN(c.commit_timestamp)');
      expect(sql).toContain('LEFT JOIN exec_commits');
      // The commit CTE is NOT restricted to STAGE rows — it scans any event of the
      // execution (the PIPELINE event carries the commit). Its only event filter
      // is `commit_timestamp IS NOT NULL`.
      expect(sql).toContain('c.commit_timestamp IS NOT NULL');
      expect(sql).not.toContain("c.event_type = 'STAGE'");
    });

    it('D2: lead time derives from the joined commit_ts on the per-execution row', async () => {
      wireScans(
        // commit_ts came from the PIPELINE event (joined in SQL); completed 1h later.
        [{ environment: 'production', execution_id: 'exec-1', status: 'SUCCEEDED', completed_at: '2026-07-02T01:00:00Z', commit_ts: '2026-07-02T00:00:00Z', in_window: true }],
        [], [], [{ registered: 1, deploying: 1 }],
      );
      const result = await service.getDoraMetrics('acme', FROM, TO);
      expect(result.environments[0].leadTime).toEqual({ deployments: 1, medianSeconds: 3600, level: 'elite' });
    });

    // Correlation look-back — the deploy scan reaches back `from − windowHours`, and
    // a look-back-only row (in_window=false) correlates an incident WITHOUT itself
    // counting toward DF/CFR attempts.
    it('correlates an incident at the window leading edge to a just-prior (out-of-window) deploy', async () => {
      wireScans(
        // Deploy completed 2h BEFORE `from` → in_window=false; kept only for correlation.
        [{ environment: 'production', execution_id: 'exec-LB', status: 'SUCCEEDED', completed_at: '2026-06-30T22:00:00Z', commit_ts: null, in_window: false }],
        [], [], [{ registered: 1, deploying: 1 }],
        // Incident opens 1h into the window — within 24h of the pre-window deploy.
        [{ environment: 'production', opened_at: '2026-07-01T01:00:00Z', resolved_at: '2026-07-01T02:00:00Z' }],
      );
      const result = await service.getDoraMetrics('acme', FROM, TO);
      const prod = result.environments[0];
      // The look-back deploy does NOT count as an in-window deployment/attempt…
      expect(prod.deploymentFrequency.deployments).toBe(0);
      expect(prod.changeFailureRate.attempts).toBe(0);
      // …but it IS the deploy the incident correlates to → post-deploy failure + MTTR.
      expect(prod.changeFailureRate.postDeployFailures).toBe(1);
      expect(result.meanTimeToRestore).toEqual({ incidents: 1, restored: 1, medianSeconds: 3600, level: 'high' });
    });

    it('widens the deploy scan lower bound to from − windowHours (look-back), keeping [from,to] in_window', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getDoraMetrics('acme', FROM, TO);
      const { sql, params } = dialect.sqlToQuery(mockExecute.mock.calls[0]?.[0] as SQL);
      expect(sql).toContain('AS in_window');
      // Default window is 24h → lower bound is FROM minus one day.
      expect(params).toContain('2026-06-30T00:00:00.000Z');
      expect(params).toContain(FROM); // the in_window boundary is still `from`
    });

    // MTTR right-censoring — a resolution AFTER `to` is unobserved: the incident
    // counts (unresolved), but contributes no recovery time (no unbounded gap).
    it('right-censors an incident resolved after the window end (counts, no MTTR gap)', async () => {
      wireScans(
        [{ environment: 'production', execution_id: 'exec-1', status: 'SUCCEEDED', completed_at: '2026-07-10T00:00:00Z', commit_ts: null, in_window: true }],
        [], [], [{ registered: 1, deploying: 1 }],
        // Opened just inside the window, resolved 2 days AFTER `to` → censored.
        [{ environment: 'production', opened_at: '2026-07-10T12:00:00Z', resolved_at: '2026-07-13T00:00:00Z' }],
      );
      const result = await service.getDoraMetrics('acme', FROM, TO);
      // Incident is attributed (CFR) but its resolution is not observed in-window.
      expect(result.environments[0].changeFailureRate.postDeployFailures).toBe(1);
      expect(result.meanTimeToRestore).toEqual({ incidents: 1, restored: 0, medianSeconds: null, level: null });
    });

    // Cache key — the effective incident window is part of the key so the scorecard
    // (default window) and an explicit /dora override never collide on stale data.
    it('cache key includes the effective incident window (default vs override differ)', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      cacheKeyLog.length = 0;
      await service.getDoraMetrics('acme', FROM, TO); // default 24h
      await service.getDoraMetrics('acme', FROM, TO, undefined, { incidentWindowHours: 1 });
      const doraKeys = cacheKeyLog.filter((k) => k.includes(':dora:'));
      expect(doraKeys).toHaveLength(2);
      expect(doraKeys[0]).not.toBe(doraKeys[1]);
      expect(doraKeys[0].endsWith(':24')).toBe(true);
      expect(doraKeys[1].endsWith(':1')).toBe(true);
    });

    // Band boundaries — DF elite is inclusive at ≥1/day; MTTR elite is EXCLUSIVE
    // below 3600s, so an exactly-3600s recovery lands in 'high'.
    it('classifies exactly 1/day DF as elite and exactly 3600s MTTR as high', async () => {
      // Exactly 10 successful deploys over the 10-day window → 1.0/day (elite).
      const deploys: unknown[] = [];
      for (let i = 0; i < 10; i++) {
        deploys.push({ environment: 'production', execution_id: `ok-${i}`, status: 'SUCCEEDED', completed_at: '2026-07-03T00:00:00Z', commit_ts: null, in_window: true });
      }
      wireScans(
        deploys, [], [], [{ registered: 1, deploying: 1 }],
        // Incident opens 12h after the deploy (within 24h) → correlates; resolved
        // exactly 3600s after opened.
        [{ environment: 'production', opened_at: '2026-07-03T12:00:00Z', resolved_at: '2026-07-03T13:00:00Z' }],
      );
      const result = await service.getDoraMetrics('acme', FROM, TO);
      const prod = result.environments[0];
      expect(prod.deploymentFrequency.perDay).toBe(1);
      expect(prod.deploymentFrequency.level).toBe('elite'); // ≥1/day inclusive
      // MTTR exactly 3600s → elite is <3600 (exclusive) → 'high'.
      expect(result.meanTimeToRestore.medianSeconds).toBe(3600);
      expect(result.meanTimeToRestore.level).toBe('high');
    });

    it('classifies exactly 5% CFR as elite (inclusive edge) and 1/day DF as elite', async () => {
      // 20 attempts, exactly 1 deploy-time failure, no post-deploy failures → 5.0%.
      const deploys: unknown[] = [
        { environment: 'production', execution_id: 'f', status: 'FAILED', completed_at: '2026-07-02T00:00:00Z', commit_ts: null, in_window: true },
      ];
      for (let i = 0; i < 19; i++) {
        deploys.push({ environment: 'production', execution_id: `s-${i}`, status: 'SUCCEEDED', completed_at: '2026-07-03T00:00:00Z', commit_ts: null, in_window: true });
      }
      wireScans(deploys, [], [], [{ registered: 1, deploying: 1 }]);
      const result = await service.getDoraMetrics('acme', FROM, TO);
      const prod = result.environments[0];
      expect(prod.changeFailureRate.rate).toBe(5);
      expect(prod.changeFailureRate.level).toBe('elite'); // ≤5% is elite
      // 19 deploys / 10 days = 1.9/day ≥1 → elite.
      expect(prod.deploymentFrequency.level).toBe('elite');
    });
  });

  // Phase 5b — per-org DORA settings (incident correlation window), the incidents
  // list, and the wiring-test dry-run correlation.
  describe('incident settings + list + test correlation (Phase 5b)', () => {
    it('getIncidentSettings returns the stored override + env default', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [{ incident_window_hours: 6, event_retention_days: null, dora_retention_days: null }] });
      const s = await service.getIncidentSettings('acme');
      expect(s).toEqual({
        incidentWindowHours: 6, defaultWindowHours: 24,
        eventRetentionDays: null, doraRetentionDays: null,
        defaultEventRetentionDays: 30, defaultDoraRetentionDays: 180,
      });
    });

    it('getIncidentSettings returns null override when no row is stored', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });
      const s = await service.getIncidentSettings('acme');
      expect(s).toEqual({
        incidentWindowHours: null, defaultWindowHours: 24,
        eventRetentionDays: null, doraRetentionDays: null,
        defaultEventRetentionDays: 30, defaultDoraRetentionDays: 180,
      });
    });

    it('getIncidentSettings surfaces stored retention overrides (Phase 7)', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [{ incident_window_hours: null, event_retention_days: 30, dora_retention_days: 180 }] });
      const s = await service.getIncidentSettings('acme');
      expect(s).toMatchObject({ eventRetentionDays: 30, doraRetentionDays: 180 });
    });

    it('setReportingSettings upserts only the provided fields and refreshes updated_at', async () => {
      const values = jest.fn<(...a: unknown[]) => unknown>();
      const onConflictDoUpdate = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
      values.mockReturnValue({ onConflictDoUpdate });
      mockInsert.mockReturnValue({ values });

      await service.setReportingSettings('acme', { incidentWindowHours: 12 });

      const inserted = values.mock.calls[0][0] as Record<string, unknown>;
      expect(inserted.orgId).toBe('acme');
      expect(inserted.incidentWindowHours).toBe(12);
      const conflictArg = onConflictDoUpdate.mock.calls[0][0] as { set: Record<string, unknown> };
      expect(conflictArg.set).toHaveProperty('incidentWindowHours', 12);
      // A partial write for the window must NOT touch retention columns in the update set.
      expect(conflictArg.set).not.toHaveProperty('eventRetentionDays');
      expect(conflictArg.set).not.toHaveProperty('doraRetentionDays');
    });

    it('setReportingSettings updates only retention columns when only retention is provided (Phase 7)', async () => {
      const values = jest.fn<(...a: unknown[]) => unknown>();
      const onConflictDoUpdate = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
      values.mockReturnValue({ onConflictDoUpdate });
      mockInsert.mockReturnValue({ values });

      await service.setReportingSettings('acme', { eventRetentionDays: 45, doraRetentionDays: 200 });

      const conflictArg = onConflictDoUpdate.mock.calls[0][0] as { set: Record<string, unknown> };
      expect(conflictArg.set).toHaveProperty('eventRetentionDays', 45);
      expect(conflictArg.set).toHaveProperty('doraRetentionDays', 200);
      expect(conflictArg.set).not.toHaveProperty('incidentWindowHours');
    });

    it('listIncidents resolves the window then LATERAL-correlates each incident', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [] }) // getIncidentSettings → default window
        .mockResolvedValueOnce({ rows: [
          { incidentId: 'i1', environment: 'production', severity: 'critical', openedAt: '2026-07-02T02:00:00Z', resolvedAt: '2026-07-02T03:00:00Z', createdAt: '2026-07-02T02:00:01Z', resolved: true, correlatedExecutionId: 'exec-A', deployCompletedAt: '2026-07-02T00:00:00Z' },
          { incidentId: 'i2', environment: 'staging', severity: 'warning', openedAt: '2026-07-03T00:00:00Z', resolvedAt: null, createdAt: '2026-07-03T00:00:01Z', resolved: false, correlatedExecutionId: null, deployCompletedAt: null },
        ] });

      const items = await service.listIncidents('acme', { limit: 25, offset: 0 });

      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ incidentId: 'i1', resolved: true, correlatedExecutionId: 'exec-A' });
      expect(items[1]).toMatchObject({ incidentId: 'i2', resolved: false, correlatedExecutionId: null });

      const dialect = new PgDialect();
      const { sql } = dialect.sqlToQuery(mockExecute.mock.calls[1]?.[0] as SQL);
      expect(sql).toContain('LATERAL');
      expect(sql).toContain('make_interval');
      expect(sql).toContain("e.status = 'SUCCEEDED'");
    });

    it('testIncidentCorrelation reports a hit when a recent deploy is in-window', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [] }) // settings → default window
        .mockResolvedValueOnce({ rows: [{ execution_id: 'exec-A', completed_at: '2026-07-02T00:00:00Z' }] });

      const r = await service.testIncidentCorrelation('acme', 'production');
      expect(r.correlated).toBe(true);
      expect(r.executionId).toBe('exec-A');
      expect(r.environment).toBe('production');
      expect(r.windowHours).toBe(24);
    });

    it('testIncidentCorrelation reports no hit when nothing is in-window', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [] }) // settings
        .mockResolvedValueOnce({ rows: [] }); // no correlating deploy
      const r = await service.testIncidentCorrelation('acme', 'production');
      expect(r.correlated).toBe(false);
      expect(r.executionId).toBeNull();
    });
  });

  // Phase 6 — per-pipeline build health (standard reporting, every tier).
  describe('getBuildHealth (Phase 6)', () => {
    it('shapes per-stage rows and sums totals across stages', async () => {
      mockExecute.mockResolvedValue({
        rows: [
          { stage: 'Build', runs: 10, successes: 8, failures: 2, successRate: 80, p50Ms: 1000, p90Ms: 2000, p99Ms: 3000 },
          { stage: 'Deploy', runs: 5, successes: 5, failures: 0, successRate: 100, p50Ms: 5000, p90Ms: 6000, p99Ms: 7000 },
        ],
      });

      const result = await service.getBuildHealth('acme', 'p1', '2026-07-01', '2026-07-11');

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.stages).toHaveLength(2);
      // Totals sum across stages: 15 runs, 2 failures → 13.3% failure rate.
      expect(result.totals).toEqual({ runs: 15, failures: 2, failureRate: 13.3 });
    });

    it('returns empty stages + zero totals when the pipeline has no stage activity', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      const result = await service.getBuildHealth('acme', 'p1', '2026-07-01', '2026-07-11');
      expect(result).toEqual({ stages: [], totals: { runs: 0, failures: 0, failureRate: 0 } });
    });

    it('rolls stages up per execution and projects duration percentiles', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getBuildHealth('acme', 'p1', '2026-07-01', '2026-07-11');
      const dialect = new PgDialect();
      const { sql, params } = dialect.sqlToQuery(mockExecute.mock.calls[0]?.[0] as SQL);
      expect(sql).toContain("e.event_type = 'STAGE'");
      expect(sql).toContain('e.pipeline_id =');
      expect(sql).toContain('PERCENTILE_CONT(0.5)');
      expect(sql).toContain('PERCENTILE_CONT(0.9)');
      expect(sql).toContain('PERCENTILE_CONT(0.99)');
      expect(params).toContain('p1');
    });
  });

  describe('recordIncident (Phase 5 upsert)', () => {
    it('upserts on (org_id, incident_id) and refreshes resolved_at', async () => {
      const values = jest.fn<(...a: unknown[]) => unknown>();
      const onConflictDoUpdate = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
      values.mockReturnValue({ onConflictDoUpdate });
      mockInsert.mockReturnValue({ values });

      await service.recordIncident('acme', {
        incidentId: 'pd-123',
        environment: 'production',
        openedAt: '2026-07-02T02:00:00Z',
        resolvedAt: '2026-07-02T03:00:00Z',
        severity: 'critical',
      });

      const inserted = values.mock.calls[0][0] as Record<string, unknown>;
      expect(inserted.incidentId).toBe('pd-123');
      expect(inserted.orgId).toBe('acme');
      expect(inserted.environment).toBe('production');
      expect(inserted.openedAt).toEqual(new Date('2026-07-02T02:00:00Z'));
      expect(inserted.resolvedAt).toEqual(new Date('2026-07-02T03:00:00Z'));
      expect(inserted.severity).toBe('critical');
      // Idempotent upsert keyed on (org_id, incident_id).
      const conflictArg = onConflictDoUpdate.mock.calls[0][0] as { set: Record<string, unknown> };
      expect(conflictArg.set).toHaveProperty('resolvedAt');
    });

    it('leaves resolved_at null for an open incident', async () => {
      const values = jest.fn<(...a: unknown[]) => unknown>();
      values.mockReturnValue({ onConflictDoUpdate: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined) });
      mockInsert.mockReturnValue({ values });

      await service.recordIncident('acme', {
        incidentId: 'pd-open', environment: 'staging', openedAt: '2026-07-02T02:00:00Z', severity: 'warning',
      });

      const inserted = values.mock.calls[0][0] as Record<string, unknown>;
      expect(inserted.resolvedAt).toBeNull();
    });
  });

  describe('getDoraTrend (deploy-basis)', () => {
    it('returns per-bucket deploy frequency + deploy-time change-failure points', async () => {
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

  // DORA generated-SQL coverage — pins the deploy-basis QUERY CONSTRUCTION
  // (rendered via drizzle's PgDialect; a live Postgres is not feasible in this
  // jest-ESM setup — see the note that used to live here). Locks the deploy-stage
  // predicate, the commit-time projection, MTTR's production-only join, and the
  // env/pipeline scope clauses.
  describe('DORA generated SQL (deploy-basis)', () => {
    const dialect = new PgDialect();
    function rendered(callIndex = 0): { sql: string; params: unknown[] } {
      const arg = mockExecute.mock.calls[callIndex]?.[0] as SQL | undefined;
      if (!arg) throw new Error(`tx.execute was not called (index ${callIndex})`);
      return dialect.sqlToQuery(arg);
    }

    const FROM = '2026-07-01T00:00:00Z';
    const TO = '2026-07-11T00:00:00Z';

    it('getDoraMetrics: deploy scan is STAGE + environment-tagged, projects commit_timestamp', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getDoraMetrics('acme', FROM, TO);

      // Call 0 = the terminal deploy-stage scan.
      const { sql } = rendered(0);
      expect(sql).toContain("e.event_type = 'STAGE'");
      expect(sql).toContain('e.environment IS NOT NULL');
      // D2: commit time joins the execution's earliest commit (any event), not
      // the deploy STAGE row — projected from the exec_commits CTE (alias `c`).
      expect(sql).toContain('commit_timestamp');
      expect(sql).toContain('exec_commits');
      // D1: per-execution grouping — one deployment per (env, execution), NOT per stage.
      expect(sql).toContain('GROUP BY e.environment, e.execution_id');
      expect(sql).not.toContain('e.stage_name');
      // No run-basis PIPELINE roll-up any more.
      expect(sql).not.toContain("e.event_type = 'PIPELINE'");
      // Unscoped ⇒ no per-pipeline / single-environment predicate.
      expect(sql).not.toContain('e.pipeline_id =');
      expect(sql).not.toContain('e.environment =');
    });

    it('getDoraMetrics: MTTR scan (call 2) is production-only and joins the deploy completion', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getDoraMetrics('acme', FROM, TO);

      const { sql, params } = rendered(2);
      expect(sql).toContain('deployment_outcomes');
      expect(sql).toContain('d.environment =');
      expect(params).toContain('production');
    });

    it('getDoraMetrics: env + pipeline scoping filters the deploy scan', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getDoraMetrics('acme', FROM, TO, undefined, { environment: 'staging', pipelineId: 'p-1' });

      const { sql, params } = rendered(0);
      expect(sql).toContain('e.pipeline_id =');
      expect(sql).toContain('e.environment =');
      expect(params).toContain('p-1');
      expect(params).toContain('staging');
    });

    it('getDoraTrend: buckets deploy-stage terminal executions (no PIPELINE roll-up)', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getDoraTrend('acme', 'day', FROM, TO);

      const { sql } = rendered(0);
      expect(sql).toContain("e.event_type = 'STAGE'");
      expect(sql).toContain('e.environment IS NOT NULL');
      expect(sql).toContain('DATE_TRUNC');
      // D1: per-execution grouping in the trend CTE, not per stage.
      expect(sql).toContain('GROUP BY e.environment, e.execution_id');
      expect(sql).not.toContain('e.stage_name');
      expect(sql).not.toContain("e.event_type = 'PIPELINE'");
    });
  });

  // Report-rollup parity: getErrors + the build reports are execution/build
  // reports, so they thread `orgIds` the same way the sibling execution reports
  // do — a multi-org rollup renders an `IN (...)` org predicate binding the
  // subtree ids (single-org stays `= $org`). Rendered via PgDialect to assert
  // the generated predicate rather than executing against a real Postgres.
  describe('report-rollup parity', () => {
    const dialect = new PgDialect();
    function rendered(callIndex = 0): { sql: string; params: unknown[] } {
      const arg = mockExecute.mock.calls[callIndex]?.[0] as SQL | undefined;
      if (!arg) throw new Error('tx.execute was not called');
      return dialect.sqlToQuery(arg);
    }

    it('getErrors: single-org uses `= $org` (no rollup)', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getErrors('acme', '2026-01-01', '2026-03-15', 10);
      const { sql, params } = rendered();
      expect(sql).toContain('p.org_id = ');
      expect(sql).not.toMatch(/p\.org_id in \(/i);
      expect(params).toContain('acme');
    });

    it('getErrors: rollup renders an IN predicate binding the subtree ids', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getErrors('acme', '2026-01-01', '2026-03-15', 10, ['acme', 'team-child']);
      const { sql, params } = rendered();
      expect(sql).toMatch(/p\.org_id in \(/i);
      expect(params).toContain('acme');
      expect(params).toContain('team-child');
    });

    it('getBuildSuccessRate: rollup renders an IN predicate on e.org_id', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getBuildSuccessRate('acme', 'week', '2026-01-01', '2026-03-15', ['acme', 'team-child']);
      const { sql, params } = rendered();
      expect(sql).toMatch(/e\.org_id in \(/i);
      expect(params).toContain('acme');
      expect(params).toContain('team-child');
    });

    it('getBuildDuration: rollup renders an IN predicate on e.org_id', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getBuildDuration('acme', '2026-01-01', '2026-03-15', ['acme', 'team-child']);
      const { sql, params } = rendered();
      expect(sql).toMatch(/e\.org_id in \(/i);
      expect(params).toContain('team-child');
    });

    it('getBuildFailures: rollup renders an IN predicate on e.org_id', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getBuildFailures('acme', '2026-01-01', '2026-03-15', 20, ['acme', 'team-child']);
      const { sql, params } = rendered();
      expect(sql).toMatch(/e\.org_id in \(/i);
      expect(params).toContain('team-child');
    });

    it('build reports default to single-org `= $org` when no rollup ids are passed', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getBuildDuration('acme', '2026-01-01', '2026-03-15');
      const { sql, params } = rendered();
      expect(sql).toContain('e.org_id = ');
      expect(sql).not.toMatch(/e\.org_id in \(/i);
      expect(params).toContain('acme');
    });
  });

  // Subtree validation for the multi-org rollup. The rollup read runs under
  // sysadmin context (RLS OFF), so `orgIds` is the ONLY tenancy gate. orgScope
  // validates defensively that the requesting (anchor) org is present in the
  // resolved set before honoring the bypass — a set that omits the caller's own
  // org is a malformed/spoofed rollup and collapses to the safe single-org scope
  // rather than reading arbitrary orgs under sysadmin.
  describe('report-rollup subtree validation', () => {
    const dialect = new PgDialect();
    function rendered(callIndex = 0): { sql: string; params: unknown[] } {
      const arg = mockExecute.mock.calls[callIndex]?.[0] as SQL | undefined;
      if (!arg) throw new Error('tx.execute was not called');
      return dialect.sqlToQuery(arg);
    }

    it('honors the rollup when the anchor org IS present in the subtree', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getErrors('acme', '2026-01-01', '2026-03-15', 10, ['acme', 'team-child']);
      const { sql, params } = rendered();
      expect(sql).toMatch(/p\.org_id in \(/i);
      expect(params).toContain('acme');
      expect(params).toContain('team-child');
    });

    it('drops a subtree that OMITS the anchor org and falls back to single-org `= $anchor`', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      // A subtree that does not include the requesting org ('acme') — e.g. a
      // spoofed/miscomputed set naming only foreign orgs — must NOT be trusted
      // under the sysadmin bypass.
      await service.getErrors('acme', '2026-01-01', '2026-03-15', 10, ['victim-org', 'other-org']);
      const { sql, params } = rendered();
      expect(sql).toContain('p.org_id = ');
      expect(sql).not.toMatch(/p\.org_id in \(/i);
      expect(params).toContain('acme');
      // The foreign ids never reach the query.
      expect(params).not.toContain('victim-org');
      expect(params).not.toContain('other-org');
    });

    it('matches the anchor case-insensitively (org id casing does not break the guard)', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getErrors('ACME', '2026-01-01', '2026-03-15', 10, ['acme', 'team-child']);
      const { sql, params } = rendered();
      // Anchor present (case-insensitively) ⇒ rollup honored.
      expect(sql).toMatch(/p\.org_id in \(/i);
      expect(params).toContain('team-child');
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

    it('guards the ::int[] version sort against non-numeric versions (no whole-summary throw)', async () => {
      // A non-numeric-dotted version ('latest', '') must not blow up the org
      // summary: the ORDER BY only casts numeric-dotted cores and sorts the rest
      // to the bottom via a sentinel, so the query never throws on bad data.
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getPluginVersions('acme');

      const dialect = new PgDialect();
      const arg = mockExecute.mock.calls[0]?.[0] as SQL;
      const { sql } = dialect.sqlToQuery(arg);
      // The cast is gated behind a numeric-dotted regex CASE (not applied to raw).
      expect(sql).toContain("~ '^[0-9]+([.][0-9]+)*$'");
      expect(sql).toContain('ELSE ARRAY[-1]');
      expect(sql).toContain('::int[]');
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

// Phase 7 — reporting retention: the resolve/cutoff age logic (standard vs DORA
// split, per-org override vs env default, boundary) + the batched per-org sweep.
describe('reporting retention (Phase 7)', () => {
  let service: ReportingService;
  beforeEach(() => { jest.clearAllMocks(); service = new ReportingService(); });

  const rows = (n: number) => Array.from({ length: n }, () => ({}));
  const render = (call: number) => new PgDialect().sqlToQuery(mockExecute.mock.calls[call]?.[0] as SQL);

  describe('resolveEventRetentionDays / resolveDoraRetentionDays', () => {
    it('falls back to the env default (30 / 180) when no override is set', () => {
      expect(resolveEventRetentionDays(null)).toBe(30);
      expect(resolveEventRetentionDays(undefined)).toBe(30);
      expect(resolveDoraRetentionDays(null)).toBe(180);
      expect(resolveDoraRetentionDays(undefined)).toBe(180);
    });

    it('a valid per-org override wins over the default', () => {
      expect(resolveEventRetentionDays(45)).toBe(45);
      expect(resolveDoraRetentionDays(400)).toBe(400);
    });

    it('rejects out-of-range/invalid overrides (clamps max, ignores < 1 and non-integers)', () => {
      expect(resolveEventRetentionDays(0)).toBe(30);      // below min → default
      expect(resolveEventRetentionDays(-5)).toBe(30);     // negative → default
      expect(resolveEventRetentionDays(1.5)).toBe(30);    // non-integer → default
      expect(resolveDoraRetentionDays(9999)).toBe(730);   // above max → clamped
    });

    it('passes the -1 unlimited sentinel through (Phase 8) instead of falling back to the default', () => {
      expect(resolveEventRetentionDays(-1)).toBe(-1);
      expect(resolveDoraRetentionDays(-1)).toBe(-1);
      // -1 is the ONLY negative that survives; -2 is still out-of-range → default.
      expect(resolveEventRetentionDays(-2)).toBe(30);
      expect(resolveDoraRetentionDays(-2)).toBe(180);
    });
  });

  describe('retentionCutoff (boundary)', () => {
    it('subtracts exactly N days from now, so rows with created_at < cutoff are expired', () => {
      const now = new Date('2026-08-20T00:00:00Z');
      expect(retentionCutoff(now, 30).toISOString()).toBe('2026-07-21T00:00:00.000Z');
      expect(retentionCutoff(now, 180).toISOString()).toBe('2026-02-21T00:00:00.000Z');
      // A row created exactly at the cutoff is NOT expired (strict <).
      expect(retentionCutoff(now, 1).getTime()).toBe(now.getTime() - 86_400_000);
    });
  });

  describe('purgeExpiredReportingData', () => {
    it('short-circuits (single query, all-zero counts) when no org has reporting data', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] }); // org enumeration → none
      const res = await service.purgeExpiredReportingData({ now: new Date('2026-08-20T00:00:00Z') });
      expect(res).toEqual({ orgs: 0, standardEvents: 0, doraEvents: 0, deploymentOutcomes: 0, incidents: 0 });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('sweeps each org with the split windows and default retention, summing per-table counts', async () => {
      const now = new Date('2026-08-20T00:00:00Z');
      mockExecute
        .mockResolvedValueOnce({ rows: [{ org_id: 'acme' }] }) // enumerate orgs
        .mockResolvedValueOnce({ rows: [] })                   // overrides (none → defaults)
        .mockResolvedValueOnce({ rows: rows(5) })              // standard events
        .mockResolvedValueOnce({ rows: rows(3) })              // dora events
        .mockResolvedValueOnce({ rows: rows(2) })              // deployment_outcomes
        .mockResolvedValueOnce({ rows: rows(1) });             // incidents

      const res = await service.purgeExpiredReportingData({ now });
      expect(res).toEqual({ orgs: 1, standardEvents: 5, doraEvents: 3, deploymentOutcomes: 2, incidents: 1 });

      // Standard-event delete: environment IS NULL, cut at the 30-day window.
      const std = render(2);
      expect(std.sql).toContain('DELETE FROM');
      expect(std.sql).toContain('ctid');
      expect(std.sql).toContain('environment IS NULL');
      expect(std.params).toContain('acme');
      expect(std.params.some((p) => p instanceof Date && (p as Date).getTime() === retentionCutoff(now, 30).getTime())).toBe(true);

      // DORA-event delete: environment IS NOT NULL, cut at the 180-day window.
      const dora = render(3);
      expect(dora.sql).toContain('environment IS NOT NULL');
      expect(dora.params.some((p) => p instanceof Date && (p as Date).getTime() === retentionCutoff(now, 180).getTime())).toBe(true);

      // deployment_outcomes + incidents both use the DORA (180-day) window.
      expect(render(4).params.some((p) => p instanceof Date && (p as Date).getTime() === retentionCutoff(now, 180).getTime())).toBe(true);
      expect(render(5).params.some((p) => p instanceof Date && (p as Date).getTime() === retentionCutoff(now, 180).getTime())).toBe(true);
    });

    it('honors a per-org override for both windows', async () => {
      const now = new Date('2026-08-20T00:00:00Z');
      mockExecute
        .mockResolvedValueOnce({ rows: [{ org_id: 'acme' }] })
        .mockResolvedValueOnce({ rows: [{ org_id: 'acme', event_retention_days: 10, dora_retention_days: 20 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await service.purgeExpiredReportingData({ now });
      expect(render(2).params.some((p) => p instanceof Date && (p as Date).getTime() === retentionCutoff(now, 10).getTime())).toBe(true);
      expect(render(3).params.some((p) => p instanceof Date && (p as Date).getTime() === retentionCutoff(now, 20).getTime())).toBe(true);
    });

    it('batches with ctid LIMIT and loops until a short batch drains the table', async () => {
      const now = new Date('2026-08-20T00:00:00Z');
      mockExecute
        .mockResolvedValueOnce({ rows: [{ org_id: 'acme' }] }) // enumerate
        .mockResolvedValueOnce({ rows: [] })                   // overrides
        .mockResolvedValueOnce({ rows: rows(2) })              // std batch 1 (== batchSize → loop)
        .mockResolvedValueOnce({ rows: rows(1) })              // std batch 2 (< batchSize → drained)
        .mockResolvedValueOnce({ rows: [] })                   // dora
        .mockResolvedValueOnce({ rows: [] })                   // outcomes
        .mockResolvedValueOnce({ rows: [] });                  // incidents

      const res = await service.purgeExpiredReportingData({ now, batchSize: 2 });
      expect(res.standardEvents).toBe(3); // 2 + 1 across two batches
      expect(render(2).sql).toContain('LIMIT');
    });

    it('skips the standard-event window for an org whose event retention is -1 (still purges DORA source)', async () => {
      const now = new Date('2026-08-20T00:00:00Z');
      mockExecute
        .mockResolvedValueOnce({ rows: [{ org_id: 'acme' }] }) // enumerate
        .mockResolvedValueOnce({ rows: [{ org_id: 'acme', event_retention_days: -1, dora_retention_days: 180 }] })
        .mockResolvedValueOnce({ rows: rows(3) })              // dora events (standard skipped → this is first delete)
        .mockResolvedValueOnce({ rows: rows(2) })              // deployment_outcomes
        .mockResolvedValueOnce({ rows: rows(1) });             // incidents

      const res = await service.purgeExpiredReportingData({ now });
      expect(res).toEqual({ orgs: 1, standardEvents: 0, doraEvents: 3, deploymentOutcomes: 2, incidents: 1 });
      // No standard-event (environment IS NULL) delete was issued for this org.
      const deletes = mockExecute.mock.calls.slice(2).map((_, i) => render(i + 2));
      expect(deletes.some((q) => q.sql.includes('environment IS NULL'))).toBe(false);
      // The first delete IS the DORA-source (environment IS NOT NULL) window.
      expect(render(2).sql).toContain('environment IS NOT NULL');
      expect(render(2).params.some((p) => p instanceof Date && (p as Date).getTime() === retentionCutoff(now, 180).getTime())).toBe(true);
    });

    it('skips the DORA-source windows for an org whose dora retention is -1 (still purges standard events)', async () => {
      const now = new Date('2026-08-20T00:00:00Z');
      mockExecute
        .mockResolvedValueOnce({ rows: [{ org_id: 'acme' }] }) // enumerate
        .mockResolvedValueOnce({ rows: [{ org_id: 'acme', event_retention_days: 30, dora_retention_days: -1 }] })
        .mockResolvedValueOnce({ rows: rows(4) });             // standard events (only delete issued)

      const res = await service.purgeExpiredReportingData({ now });
      expect(res).toEqual({ orgs: 1, standardEvents: 4, doraEvents: 0, deploymentOutcomes: 0, incidents: 0 });
      // Only ONE delete ran (standard); no DORA-source deletes were issued.
      expect(mockExecute).toHaveBeenCalledTimes(3); // enumerate + overrides + 1 delete
      expect(render(2).sql).toContain('environment IS NULL');
      expect(render(2).params.some((p) => p instanceof Date && (p as Date).getTime() === retentionCutoff(now, 30).getTime())).toBe(true);
    });

    it('fully skips an org whose event AND dora retention are both -1 (no deletes issued)', async () => {
      const now = new Date('2026-08-20T00:00:00Z');
      mockExecute
        .mockResolvedValueOnce({ rows: [{ org_id: 'acme' }] }) // enumerate
        .mockResolvedValueOnce({ rows: [{ org_id: 'acme', event_retention_days: -1, dora_retention_days: -1 }] });

      const res = await service.purgeExpiredReportingData({ now });
      expect(res).toEqual({ orgs: 1, standardEvents: 0, doraEvents: 0, deploymentOutcomes: 0, incidents: 0 });
      // Only the enumeration + overrides reads ran; no DELETE statements at all.
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it('still purges a normal org in the same run while fully skipping an unlimited org', async () => {
      const now = new Date('2026-08-20T00:00:00Z');
      mockExecute
        .mockResolvedValueOnce({ rows: [{ org_id: 'unlimited' }, { org_id: 'acme' }] }) // enumerate (unlimited first)
        .mockResolvedValueOnce({ rows: [{ org_id: 'unlimited', event_retention_days: -1, dora_retention_days: -1 }] }) // acme has no override row → defaults
        .mockResolvedValueOnce({ rows: rows(5) })              // acme standard events
        .mockResolvedValueOnce({ rows: rows(3) })              // acme dora events
        .mockResolvedValueOnce({ rows: rows(2) })              // acme deployment_outcomes
        .mockResolvedValueOnce({ rows: rows(1) });             // acme incidents

      const res = await service.purgeExpiredReportingData({ now });
      expect(res).toEqual({ orgs: 2, standardEvents: 5, doraEvents: 3, deploymentOutcomes: 2, incidents: 1 });
      // The 'unlimited' org issued no deletes; the four deletes all target 'acme'.
      expect(mockExecute).toHaveBeenCalledTimes(6); // enumerate + overrides + 4 acme deletes
      for (let i = 2; i <= 5; i++) {
        expect(render(i).params).toContain('acme');
        expect(render(i).params).not.toContain('unlimited');
      }
      expect(render(2).sql).toContain('environment IS NULL');
      expect(render(3).sql).toContain('environment IS NOT NULL');
    });
  });
});
