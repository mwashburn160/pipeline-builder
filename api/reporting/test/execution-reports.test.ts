// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for execution report routes.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetExecutionCount = jest.fn();
const mockListPipelineExecutions = jest.fn();
const mockGetSuccessRate = jest.fn();
const mockGetAverageDuration = jest.fn();
const mockGetStageFailures = jest.fn();
const mockGetStageBottlenecks = jest.fn();
const mockGetActionFailures = jest.fn();
const mockGetErrors = jest.fn();
const mockResolveOrgRollup = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn(),
  sendError: jest.fn(),
  sendBadRequest: jest.fn(),
  getServiceAuthHeader: jest.fn(() => ({})),
  // Pass query.from/to through verbatim so tests can assert on the values
  // they sent, with a sensible fallback when the test omits them.
  parseDateRange: jest.fn((query: any) => ({
    from: query?.from ?? '2026-01-01T00:00:00Z',
    to: query?.to ?? '2026-01-31T00:00:00Z',
  })),
  REPORT_INTERVALS: ['day', 'week', 'month'] as const,
  parseReportInterval: jest.fn((query: any) => {
    const interval = String(query?.interval ?? 'week');
    return ['day', 'week', 'month'].includes(interval)
      ? interval
      : { error: 'interval must be one of: day, week, month' };
  }),
  isSystemAdmin: jest.fn((req: any) => req?.user?.isSuperAdmin === true),
  parseQueryIntClamped: jest.fn((val: any, def: number, max: number) =>
    Math.min(Math.max(1, parseInt(String(val ?? def), 10) || def), max)),
  validateBulkArray: jest.fn((value: any, _name: string, max?: number) =>
    Array.isArray(value) && value.length > 0 && (!max || value.length <= max)
      ? { value }
      : { error: 'invalid' }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.unstable_mockModule('../src/helpers.js', () => {
  const actual = jest.requireActual('../src/helpers.js') as Record<string, unknown>;
  return {
    ...actual,
    resolveOrgRollup: (...a: unknown[]) => mockResolveOrgRollup(...a),
  };
});

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  reportingService: {
    getExecutionCount: mockGetExecutionCount,
    listPipelineExecutions: mockListPipelineExecutions,
    getSuccessRate: mockGetSuccessRate,
    getAverageDuration: mockGetAverageDuration,
    getStageFailures: mockGetStageFailures,
    getStageBottlenecks: mockGetStageBottlenecks,
    getActionFailures: mockGetActionFailures,
    getErrors: mockGetErrors,
  },
}));

const { sendSuccess, sendBadRequest } = await import('@pipeline-builder/api-core');
const { createExecutionReportRoutes } = await import('../src/routes/execution-reports.js');

describe('Execution Report Routes', () => {
  let router: any;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createExecutionReportRoutes();
  });

  function getHandler(path: string) {
    return router.stack.find((l: any) => l.route?.path === path)?.route?.stack[0]?.handle;
  }

  describe('GET /count', () => {
    it('should call getExecutionCount with orgId', async () => {
      mockGetExecutionCount.mockResolvedValue([{ id: 'p1', total: 10 }]);
      const handler = getHandler('/count');
      const req = { query: {} };
      const res = {};

      await handler(req, res);

      // 2nd arg is the optional org→team rollup id-list (undefined without ?includeDescendants).
      expect(mockGetExecutionCount).toHaveBeenCalledWith('acme', undefined);
      expect(sendSuccess).toHaveBeenCalled();
    });
  });

  describe('GET /success-rate', () => {
    it('should call getSuccessRate with interval and range', async () => {
      mockGetSuccessRate.mockResolvedValue([{ period: '2026-03', succeeded: 5 }]);
      const handler = getHandler('/success-rate');
      const req = { query: { interval: 'month', from: '2026-01-01', to: '2026-03-15' } };
      const res = {};

      await handler(req, res);

      expect(mockGetSuccessRate).toHaveBeenCalledWith('acme', 'month', '2026-01-01', '2026-03-15', undefined);
    });

    it('should reject invalid interval', async () => {
      const handler = getHandler('/success-rate');
      const req = { query: { interval: 'invalid' } };
      const res = {};

      await handler(req, res);

      expect(sendBadRequest).toHaveBeenCalled();
    });

    it('should default to week interval', async () => {
      mockGetSuccessRate.mockResolvedValue([]);
      const handler = getHandler('/success-rate');
      const req = { query: {} };
      const res = {};

      await handler(req, res);

      expect(mockGetSuccessRate).toHaveBeenCalledWith('acme', 'week', expect.any(String), expect.any(String), undefined);
    });
  });

  // SECURITY: ?includeDescendants rollup is admin-only — members get no
  // inherited downward visibility into their teams.
  describe('rollup auth gate (?includeDescendants)', () => {
    it('resolves descendants for an org admin', async () => {
      mockResolveOrgRollup.mockResolvedValue(['acme', 'team-child']);
      mockGetExecutionCount.mockResolvedValue([]);
      const handler = getHandler('/count');
      await handler({ query: { includeDescendants: 'true' }, user: { role: 'admin' } }, {});
      expect(mockResolveOrgRollup).toHaveBeenCalledWith('acme');
      expect(mockGetExecutionCount).toHaveBeenCalledWith('acme', ['acme', 'team-child']);
    });

    it('ignores the flag for a member (single-org report, no rollup)', async () => {
      mockGetExecutionCount.mockResolvedValue([]);
      const handler = getHandler('/count');
      await handler({ query: { includeDescendants: 'true' }, user: { role: 'member' } }, {});
      expect(mockResolveOrgRollup).not.toHaveBeenCalled();
      expect(mockGetExecutionCount).toHaveBeenCalledWith('acme', undefined);
    });
  });

  describe('GET /list (per-pipeline executions)', () => {
    it('400s when pipelineId is missing', async () => {
      const handler = getHandler('/list');
      await handler({ query: {} }, {});
      expect(sendBadRequest).toHaveBeenCalled();
      expect(mockListPipelineExecutions).not.toHaveBeenCalled();
    });

    it('passes pipelineId, org, range and limit (no rollup by default)', async () => {
      mockListPipelineExecutions.mockResolvedValue([
        { executionId: 'e1', status: 'succeeded', startedAt: '2026-07-01', endedAt: '2026-07-01', durationMs: 1000, failingStage: null, failingAction: null },
      ]);
      const handler = getHandler('/list');
      await handler({ query: { pipelineId: 'p1', from: '2026-06-01', to: '2026-07-01', limit: '25' } }, {});
      // (orgId, pipelineId, orgIds=undefined, range, limit)
      expect(mockListPipelineExecutions).toHaveBeenCalledWith(
        'acme', 'p1', undefined, { from: '2026-06-01', to: '2026-07-01' }, 25,
      );
      expect(sendSuccess).toHaveBeenCalled();
    });

    // ORG-SCOPING: an admin's ?includeDescendants rollup passes the resolved
    // org→team subtree as `orgIds`; the service's `IN (...)` predicate then
    // bounds the query to those orgs, so another org's executions are excluded.
    it('scopes to the org subtree for an admin rollup', async () => {
      mockResolveOrgRollup.mockResolvedValue(['acme', 'team-child']);
      mockListPipelineExecutions.mockResolvedValue([]);
      const handler = getHandler('/list');
      await handler({ query: { pipelineId: 'p1', includeDescendants: 'true' }, user: { role: 'admin' } }, {});
      expect(mockResolveOrgRollup).toHaveBeenCalledWith('acme');
      expect(mockListPipelineExecutions).toHaveBeenCalledWith(
        'acme', 'p1', ['acme', 'team-child'], expect.any(Object), expect.any(Number),
      );
    });
  });

  describe('GET /stage-failures', () => {
    it('should return stage failure data', async () => {
      mockGetStageFailures.mockResolvedValue([{ stage_name: 'Build', failures: 3 }]);
      const handler = getHandler('/stage-failures');
      const req = { query: {} };
      const res = {};

      await handler(req, res);

      expect(mockGetStageFailures).toHaveBeenCalled();
      expect(sendSuccess).toHaveBeenCalled();
    });
  });

  describe('GET /errors', () => {
    it('should pass limit parameter', async () => {
      mockGetErrors.mockResolvedValue([]);
      const handler = getHandler('/errors');
      // /errors is system-admin-only; mark the request principal so the
      // isSystemAdmin gate passes.
      const req = { query: { limit: '10' }, user: { isSuperAdmin: true } };
      const res = {};

      await handler(req, res);

      expect(mockGetErrors).toHaveBeenCalledWith('acme', expect.any(String), expect.any(String), 10);
    });
  });
});
