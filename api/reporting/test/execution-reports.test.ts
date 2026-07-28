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
const mockGetDoraMetrics = jest.fn();
const mockGetDoraTrend = jest.fn();
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
  userHasPermission: jest.fn((req: any, perm: string) =>
    req?.user?.isSuperAdmin === true || (req?.user?.permissions ?? []).includes(perm)),
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

// helpers.js now imports `Config` from pipeline-core (to resolve the platform
// host/port for the shared org-descendants client). requireActual('../src/helpers.js')
// below loads that module, so stub pipeline-core here to keep its full config
// graph (aws-cdk-lib, etc.) out of this api-core-mocking suite. resolveOrgRollup
// itself is mocked, so Config.get is never actually invoked.
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: {
    get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }),
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
    getDoraMetrics: mockGetDoraMetrics,
    getDoraTrend: mockGetDoraTrend,
  },
}));

const { sendSuccess, sendBadRequest, parseDateRange } = await import('@pipeline-builder/api-core');
const { createExecutionReportRoutes } = await import('../src/routes/execution-reports.js');

describe('Execution Report Routes', () => {
  let router: any;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createExecutionReportRoutes();
  });

  function getHandler(path: string) {
    // Return the LAST handler in the route's stack: routes gated by a
    // middleware (e.g. requireFeature on /dora) register [gate, withRoute],
    // and the withRoute handler we want to drive is always last.
    const stack = router.stack.find((l: any) => l.route?.path === path)?.route?.stack;
    return stack?.[stack.length - 1]?.handle;
  }

  describe('GET /count', () => {
    it('should call getExecutionCount with orgId', async () => {
      mockGetExecutionCount.mockResolvedValue([{ id: 'p1', total: 10 }]);
      const handler = getHandler('/count');
      const req = { query: {} };
      const res = {};

      await handler(req, res);

      // 2nd arg is the optional org→team rollup id-list (undefined without ?includeDescendants);
      // 3rd is the optional [from,to] window (undefined when the query has no from/to → all-time).
      expect(mockGetExecutionCount).toHaveBeenCalledWith('acme', undefined, undefined);
      expect(sendSuccess).toHaveBeenCalled();
    });

    it('passes the [from,to] window when the query supplies from+to', async () => {
      mockGetExecutionCount.mockResolvedValue([]);
      const handler = getHandler('/count');
      await handler({ query: { from: '2026-06-01', to: '2026-07-01' } }, {});

      expect(mockGetExecutionCount).toHaveBeenCalledWith('acme', undefined,
        { from: '2026-06-01', to: '2026-07-01' });
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

  // SECURITY: ?includeDescendants rollup requires the `reports:rollup`
  // capability (built-in Admin/Owner + superadmin; grantable to a custom Role) —
  // callers without it get no inherited downward visibility into their teams.
  describe('rollup auth gate (?includeDescendants)', () => {
    it('resolves descendants for a caller holding reports:rollup', async () => {
      mockResolveOrgRollup.mockResolvedValue(['acme', 'team-child']);
      mockGetExecutionCount.mockResolvedValue([]);
      const handler = getHandler('/count');
      await handler({ query: { includeDescendants: 'true' }, user: { permissions: ['reports:rollup'] } }, {});
      expect(mockResolveOrgRollup).toHaveBeenCalledWith('acme');
      expect(mockGetExecutionCount).toHaveBeenCalledWith('acme', ['acme', 'team-child'], undefined);
    });

    it('resolves descendants for a superadmin (implicit-all)', async () => {
      mockResolveOrgRollup.mockResolvedValue(['acme', 'team-child']);
      mockGetExecutionCount.mockResolvedValue([]);
      const handler = getHandler('/count');
      await handler({ query: { includeDescendants: 'true' }, user: { isSuperAdmin: true } }, {});
      expect(mockResolveOrgRollup).toHaveBeenCalledWith('acme');
    });

    it('ignores the flag without reports:rollup (single-org report, no rollup)', async () => {
      mockGetExecutionCount.mockResolvedValue([]);
      const handler = getHandler('/count');
      // A coarse admin label with permissions that do NOT include reports:rollup
      // no longer rolls up — the label alone grants nothing.
      await handler({ query: { includeDescendants: 'true' }, user: { role: 'admin', permissions: ['reports:read'] } }, {});
      expect(mockResolveOrgRollup).not.toHaveBeenCalled();
      expect(mockGetExecutionCount).toHaveBeenCalledWith('acme', undefined, undefined);
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

    // ORG-SCOPING: a reports:rollup holder's ?includeDescendants rollup passes
    // the resolved org→team subtree as `orgIds`; the service's `IN (...)`
    // predicate then bounds the query to those orgs, so another org's executions
    // are excluded.
    it('scopes to the org subtree for a reports:rollup holder', async () => {
      mockResolveOrgRollup.mockResolvedValue(['acme', 'team-child']);
      mockListPipelineExecutions.mockResolvedValue([]);
      const handler = getHandler('/list');
      await handler({ query: { pipelineId: 'p1', includeDescendants: 'true' }, user: { permissions: ['reports:rollup'] } }, {});
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

  describe('GET /dora', () => {
    const sampleDora = {
      window: { from: '2026-06-01', to: '2026-07-01' },
      basis: 'run',
      filters: { pipelineId: null, environment: null },
      deploymentFrequency: { deployments: 8, perDay: 0.27, level: 'high' },
      changeFailureRate: { failed: 2, total: 10, pct: 20.0, level: 'low' },
      meanTimeToRestore: { failures: 2, restored: 1, avgSeconds: 300, level: 'elite' },
      leadTime: { deployments: 8, medianSeconds: 180, approx: true, level: 'elite' },
    };
    // Default scoping the route derives from an empty query string.
    const noScope = { pipelineId: undefined, environment: undefined, deploysOnly: false };

    it('returns the DORA shape and passes org + range (no rollup by default)', async () => {
      mockGetDoraMetrics.mockResolvedValue(sampleDora);
      const handler = getHandler('/dora');
      await handler({ query: { from: '2026-06-01', to: '2026-07-01' } }, {});

      expect(mockGetDoraMetrics).toHaveBeenCalledWith('acme', '2026-06-01', '2026-07-01', undefined, noScope);
      expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { dora: sampleDora });
    });

    it('400s on a bad date range and does not query', async () => {
      (parseDateRange as jest.Mock).mockReturnValueOnce({ error: 'Date range exceeds maximum of 365 days' });
      const handler = getHandler('/dora');
      await handler({ query: { from: 'x', to: 'y' } }, {});

      expect(sendBadRequest).toHaveBeenCalled();
      expect(mockGetDoraMetrics).not.toHaveBeenCalled();
    });

    // Rollup gating identical to the sibling routes: the subtree is passed only
    // for a reports:rollup holder using ?includeDescendants.
    it('scopes to the org subtree for a reports:rollup holder', async () => {
      mockResolveOrgRollup.mockResolvedValue(['acme', 'team-child']);
      mockGetDoraMetrics.mockResolvedValue(sampleDora);
      const handler = getHandler('/dora');
      await handler({ query: { includeDescendants: 'true' }, user: { permissions: ['reports:rollup'] } }, {});

      expect(mockResolveOrgRollup).toHaveBeenCalledWith('acme');
      expect(mockGetDoraMetrics).toHaveBeenCalledWith('acme', expect.any(String), expect.any(String), ['acme', 'team-child'], noScope);
    });

    it('ignores ?includeDescendants without reports:rollup (single-org)', async () => {
      mockGetDoraMetrics.mockResolvedValue(sampleDora);
      const handler = getHandler('/dora');
      await handler({ query: { includeDescendants: 'true' }, user: { permissions: ['reports:read'] } }, {});

      expect(mockResolveOrgRollup).not.toHaveBeenCalled();
      expect(mockGetDoraMetrics).toHaveBeenCalledWith('acme', expect.any(String), expect.any(String), undefined, noScope);
    });

    it('passes per-pipeline + deploy scoping from the query string', async () => {
      mockGetDoraMetrics.mockResolvedValue(sampleDora);
      const handler = getHandler('/dora');
      await handler({ query: { pipelineId: 'p-1', environment: 'production', deploysOnly: 'true' } }, {});

      expect(mockGetDoraMetrics).toHaveBeenCalledWith('acme', expect.any(String), expect.any(String), undefined,
        { pipelineId: 'p-1', environment: 'production', deploysOnly: true });
    });
  });

  describe('GET /dora/trend', () => {
    const sampleTrend = [{ period: '2026-06-01', deployments: 4, failed: 1, total: 5, changeFailurePct: 20 }];

    it('passes interval + range + scoping and returns the trend', async () => {
      mockGetDoraTrend.mockResolvedValue(sampleTrend);
      const handler = getHandler('/dora/trend');
      await handler({ query: { interval: 'day', from: '2026-06-01', to: '2026-07-01' } }, {});

      expect(mockGetDoraTrend).toHaveBeenCalledWith('acme', 'day', '2026-06-01', '2026-07-01', undefined,
        { pipelineId: undefined, environment: undefined, deploysOnly: false });
      expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { trend: sampleTrend });
    });

    it('400s on a bad interval and does not query', async () => {
      mockGetDoraTrend.mockClear();
      const handler = getHandler('/dora/trend');
      await handler({ query: { interval: 'decade' } }, {});

      expect(sendBadRequest).toHaveBeenCalled();
      expect(mockGetDoraTrend).not.toHaveBeenCalled();
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
