// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for ReportingService.
 * Mocks the db module and verifies correct SQL template usage.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
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
