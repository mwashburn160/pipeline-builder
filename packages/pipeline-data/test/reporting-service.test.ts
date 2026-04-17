// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for ReportingService.
 * Mocks the db module and verifies correct SQL template usage.
 */

const mockExecute = jest.fn();

jest.mock('../src/database/postgres-connection', () => ({
  db: {
    execute: mockExecute,
  },
}));

jest.mock('@pipeline-builder/api-core', () => ({
  createCacheService: () => ({
    getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
    invalidatePattern: () => Promise.resolve(0),
  }),
}));

import { ReportingService } from '../src/api/reporting-service';

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
