// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for execution report routes.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetExecutionCount = jest.fn<AnyFn>();
const mockListPipelineExecutions = jest.fn<AnyFn>();
const mockGetSuccessRate = jest.fn<AnyFn>();
const mockGetAverageDuration = jest.fn<AnyFn>();
const mockGetStageFailures = jest.fn<AnyFn>();
const mockGetStageBottlenecks = jest.fn<AnyFn>();
const mockGetActionFailures = jest.fn<AnyFn>();
const mockGetReportEnvironments = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockGetPlatformErrors = jest.fn<AnyFn>();
const mockGetErrorCategories = jest.fn<AnyFn>();
const mockGetFlakyStages = jest.fn<AnyFn>();
const mockGetFlakyStageTrend = jest.fn<AnyFn>();
const mockGetDoraMetrics = jest.fn<AnyFn>();
const mockGetDoraTrend = jest.fn<AnyFn>();
const mockGetBuildHealth = jest.fn<AnyFn>();
const mockResolveOrgRollup = jest.fn<AnyFn>();

// The single reports:rollup predicate — shared by the api-core `userHasPermission`
// mock and the helpers `rollupIds` mock so the two can't diverge in-test.
const permCheck = (req: any, perm: string) =>
  req?.user?.isSuperAdmin === true || (req?.user?.permissions ?? []).includes(perm);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn<AnyFn>(),
  sendError: jest.fn<AnyFn>(),
  sendBadRequest: jest.fn<AnyFn>(),
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
  userHasPermission: jest.fn(permCheck),
  parseQueryIntClamped: jest.fn((val: any, def: number, max: number) =>
    Math.min(Math.max(1, parseInt(String(val ?? def), 10) || def), max)),
  validateBulkArray: jest.fn((value: any, _name: string, max?: number) =>
    Array.isArray(value) && value.length > 0 && (!max || value.length <= max)
      ? { value }
      : { error: 'invalid' }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn<AnyFn>(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

// helpers/report-helpers.js now imports `Config` from pipeline-core (to resolve the platform
// host/port for the shared org-descendants client). requireActual('../src/helpers/report-helpers.js')
// below loads that module, so stub pipeline-core here to keep its full config
// graph (aws-cdk-lib, etc.) out of this api-core-mocking suite. resolveOrgRollup
// itself is mocked, so Config.get is never actually invoked.
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: {
    get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }),
  },
}));

// `rollupIds` now lives in helpers/report-helpers.js (shared by both report routers). Because it
// calls `resolveOrgRollup` intra-module, overriding only the resolveOrgRollup
// export can't intercept it, so override `rollupIds` too — reproducing its gate
// (reports:rollup + ?includeDescendants) against the mocked resolveOrgRollup, so
// the existing mockResolveOrgRollup assertions still hold.
jest.unstable_mockModule('../src/helpers/report-helpers.js', () => {
  const actual = jest.requireActual('../src/helpers/report-helpers.js') as Record<string, unknown>;
  return {
    ...actual,
    resolveOrgRollup: (...a: unknown[]) => mockResolveOrgRollup(...a),
    rollupIds: (req: any, orgId: string) =>
      req?.query?.includeDescendants === 'true' && permCheck(req, 'reports:rollup')
        ? mockResolveOrgRollup(orgId)
        : Promise.resolve(undefined),
  };
});

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: {
    getExecutionCount: mockGetExecutionCount,
    listPipelineExecutions: mockListPipelineExecutions,
    getSuccessRate: mockGetSuccessRate,
    getAverageDuration: mockGetAverageDuration,
    getStageFailures: mockGetStageFailures,
    getStageBottlenecks: mockGetStageBottlenecks,
    getActionFailures: mockGetActionFailures,
    getReportEnvironments: mockGetReportEnvironments,
    getPlatformErrors: mockGetPlatformErrors,
    getErrorCategories: mockGetErrorCategories,
    getFlakyStages: mockGetFlakyStages,
    getFlakyStageTrend: mockGetFlakyStageTrend,
    getDoraMetrics: mockGetDoraMetrics,
    getDoraTrend: mockGetDoraTrend,
    getBuildHealth: mockGetBuildHealth,
    // The /dora route resolves the per-org incident window first.
    // The retention window (cap + `from` floor) is derived from the
    // same row — use UNLIMITED retention here so the floor is inert and these
    // suites keep asserting the exact from/to they send (the floor itself is
    // unit-tested in retention-cap.test).
    getReportingSettings: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({
      incidentWindowHours: null,
      defaultWindowHours: 24,
      eventRetentionDays: -1,
      doraRetentionDays: -1,
      defaultEventRetentionDays: 30,
      defaultDoraRetentionDays: 180,
    }),
  },
}));

const { sendSuccess, sendBadRequest, parseDateRange, getRouteGates } = await import('@pipeline-builder/api-core');
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

      expect(mockGetSuccessRate).toHaveBeenCalledWith('acme', 'month', '2026-01-01', '2026-03-15', undefined,
        { tz: 'UTC', weekStart: 'monday' });
    });

    it('buckets in the requested timezone and week start (the stakeholder report\'s bucketing)', async () => {
      mockGetSuccessRate.mockResolvedValue([]);
      const handler = getHandler('/success-rate');
      await handler({ query: { interval: 'week', tz: 'America/Chicago', weekStart: 'sunday' } }, {});

      expect(mockGetSuccessRate).toHaveBeenCalledWith('acme', 'week', expect.any(String), expect.any(String), undefined,
        { tz: 'America/Chicago', weekStart: 'sunday' });
    });

    it('400s on an invalid timezone and does not query', async () => {
      const handler = getHandler('/success-rate');
      await handler({ query: { tz: 'Mars/Olympus_Mons' } }, {});

      expect(sendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('tz must be a valid IANA timezone'), expect.anything());
      expect(mockGetSuccessRate).not.toHaveBeenCalled();
    });

    it('400s on a bare UTC offset (no DST rules) and on an unknown week start', async () => {
      const handler = getHandler('/success-rate');
      await handler({ query: { tz: '+05:00' } }, {});
      await handler({ query: { weekStart: 'friday' } }, {});

      expect(sendBadRequest).toHaveBeenCalledTimes(2);
      expect(mockGetSuccessRate).not.toHaveBeenCalled();
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

      expect(mockGetSuccessRate).toHaveBeenCalledWith('acme', 'week', expect.any(String), expect.any(String), undefined,
        { tz: 'UTC', weekStart: 'monday' });
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

  // The remaining single-query routes share one shape: resolve the report
  // scope (range + rollup), refuse a bad range with 400 before querying, then
  // answer the one service call under its own response key.
  describe.each([
    ['/duration', mockGetAverageDuration, 'pipelines'],
    ['/stage-failures', mockGetStageFailures, 'stages'],
    ['/stage-bottlenecks', mockGetStageBottlenecks, 'stages'],
    ['/action-failures', mockGetActionFailures, 'actions'],
    ['/environments', mockGetReportEnvironments, 'environments'],
  ] as const)('GET %s', (path, query, key) => {
    it('answers the service rows under its key', async () => {
      query.mockResolvedValue([{ row: 1 }]);
      await getHandler(path)({ query: {} }, {});
      expect(query).toHaveBeenCalled();
      expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { [key]: [{ row: 1 }] });
    });

    it('400s on a bad date range and does not query', async () => {
      (parseDateRange as jest.Mock<AnyFn>).mockReturnValueOnce({ error: 'Date range exceeds maximum of 365 days' });
      await getHandler(path)({ query: { from: 'x', to: 'y' } }, {});
      expect(sendBadRequest).toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('GET /dora', () => {
    // Deploy-basis DORA shape (per-env cards + production MTTR + coverage).
    const sampleDora = {
      window: { from: '2026-06-01', to: '2026-07-01' },
      filters: { pipelineId: null, environment: null },
      headline: 'production',
      environments: [{
        environment: 'production',
        deploymentFrequency: { deployments: 8, perDay: 0.27, level: 'high' },
        changeFailureRate: { rate: 20.0, deployTimeFailures: 1, postDeployFailures: 1, attempts: 10, level: 'low' },
        leadTime: { deployments: 8, medianSeconds: 180, level: 'elite' },
      }],
      meanTimeToRestore: { incidents: 2, restored: 1, medianSeconds: 300, level: 'elite' },
      coverage: { registered: 12, deploying: 4, withoutDeploys: 8 },
    };
    // Default scoping the route derives from an empty query string (deploysOnly
    // is gone — DORA is deploy-basis only now).
    const noScope = { pipelineId: undefined, environment: undefined };

    it('returns the DORA shape and passes org + range (no rollup by default)', async () => {
      mockGetDoraMetrics.mockResolvedValue(sampleDora);
      const handler = getHandler('/dora');
      await handler({ query: { from: '2026-06-01', to: '2026-07-01' } }, {});

      expect(mockGetDoraMetrics).toHaveBeenCalledWith('acme', '2026-06-01', '2026-07-01', undefined, noScope);
      expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { dora: sampleDora });
    });

    it('400s on a bad date range and does not query', async () => {
      (parseDateRange as jest.Mock<AnyFn>).mockReturnValueOnce({ error: 'Date range exceeds maximum of 365 days' });
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

    it('passes per-pipeline + environment scoping from the query string', async () => {
      mockGetDoraMetrics.mockResolvedValue(sampleDora);
      const handler = getHandler('/dora');
      await handler({ query: { pipelineId: 'p-1', environment: 'production' } }, {});

      expect(mockGetDoraMetrics).toHaveBeenCalledWith('acme', expect.any(String), expect.any(String), undefined,
        { pipelineId: 'p-1', environment: 'production' });
    });
  });

  describe('GET /dora/trend', () => {
    const sampleTrend = [{ period: '2026-06-01', deployments: 4, failed: 1, total: 5, changeFailurePct: 20 }];

    it('passes interval + range + scoping and returns the trend', async () => {
      mockGetDoraTrend.mockResolvedValue(sampleTrend);
      const handler = getHandler('/dora/trend');
      await handler({ query: { interval: 'day', from: '2026-06-01', to: '2026-07-01' } }, {});

      expect(mockGetDoraTrend).toHaveBeenCalledWith('acme', 'day', '2026-06-01', '2026-07-01', undefined,
        { pipelineId: undefined, environment: undefined, incidentWindowHours: undefined, tz: 'UTC', weekStart: 'monday' });
      expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { trend: sampleTrend });
    });

    it('threads tz + weekStart into the trend buckets, like the dora_trend section', async () => {
      mockGetDoraTrend.mockResolvedValue([]);
      const handler = getHandler('/dora/trend');
      await handler({ query: { interval: 'week', tz: 'Europe/Berlin', weekStart: 'sunday' } }, {});

      expect(mockGetDoraTrend).toHaveBeenCalledWith('acme', 'week', expect.any(String), expect.any(String), undefined,
        expect.objectContaining({ tz: 'Europe/Berlin', weekStart: 'sunday' }));
    });

    it('400s on an invalid timezone and does not query', async () => {
      const handler = getHandler('/dora/trend');
      await handler({ query: { tz: 'Not/AZone' } }, {});

      expect(sendBadRequest).toHaveBeenCalled();
      expect(mockGetDoraTrend).not.toHaveBeenCalled();
    });

    it('400s on a bad interval and does not query', async () => {
      mockGetDoraTrend.mockClear();
      const handler = getHandler('/dora/trend');
      await handler({ query: { interval: 'decade' } }, {});

      expect(sendBadRequest).toHaveBeenCalled();
      expect(mockGetDoraTrend).not.toHaveBeenCalled();
    });
  });

  describe('GET /build-health', () => {
    const sample = { stages: [{ stage: 'Build', runs: 10, successes: 8, failures: 2, successRate: 80, p50Ms: 1000, p90Ms: 2000, p99Ms: 3000 }], totals: { runs: 10, failures: 2, failureRate: 20 } };

    it('passes pipelineId + range and returns the per-stage breakdown', async () => {
      mockGetBuildHealth.mockResolvedValue(sample);
      const handler = getHandler('/build-health');
      await handler({ query: { pipelineId: 'p-1', from: '2026-06-01', to: '2026-07-01' } }, {});

      expect(mockGetBuildHealth).toHaveBeenCalledWith('acme', 'p-1', '2026-06-01', '2026-07-01', undefined);
      expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { buildHealth: sample });
    });

    it('400s when pipelineId is missing and does not query', async () => {
      const handler = getHandler('/build-health');
      await handler({ query: {} }, {});

      expect(sendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('pipelineId'), expect.anything());
      expect(mockGetBuildHealth).not.toHaveBeenCalled();
    });

    it('rolls up over the org→team subtree for a reports:rollup holder', async () => {
      mockGetBuildHealth.mockResolvedValue(sample);
      mockResolveOrgRollup.mockResolvedValue(['acme', 'team-child']);
      const handler = getHandler('/build-health');
      await handler({ query: { pipelineId: 'p-1', includeDescendants: 'true' }, user: { permissions: ['reports:rollup'] } }, {});

      expect(mockGetBuildHealth).toHaveBeenCalledWith('acme', 'p-1', expect.any(String), expect.any(String), ['acme', 'team-child']);
    });
  });

  describe('GET /errors', () => {
    // Cross-org error TEXT, so it moved off the superadmin FLAG onto
    // `orgs:read` — a Platform Operator read of ANOTHER org's rows, which is
    // customer data rather than this deploy's configuration. `requireSystemOrgPermission`
    // composes the three conditions a system-org-only permission needs, and the
    // order matters: requireSystemOrg first, then the permission, then the
    // assurance level. Asserting the WHOLE chain rather than one function keeps
    // a route from quietly losing the org check or the MFA requirement, which is
    // the half a single-function assertion never noticed.
    it('is gated by the full system-org permission chain', () => {
      const stack = router.stack.find((l: any) => l.route?.path === '/errors')?.route?.stack;
      const gates = stack.slice(0, 3).map((s: any) => getRouteGates(s.handle)).flat();
      expect(gates).toEqual([
        { kind: 'systemOrg' },
        expect.objectContaining({ kind: 'permission', mode: 'any', permissions: ['orgs:read'] }),
        expect.objectContaining({ kind: 'assurance', minAssurance: 2 }),
      ]);
    });

    // Cross-org: the operator's read spans every org, so the caller's org is
    // never an argument and ?includeDescendants has nothing to resolve.
    it('reads across every org — no caller org, no rollup', async () => {
      mockGetPlatformErrors.mockResolvedValue([{ error_pattern: 'boom', occurrences: 1 }]);
      const handler = getHandler('/errors');
      const req = { query: { limit: '10', includeDescendants: 'true' }, user: { isSuperAdmin: true } };
      await handler(req, {});

      expect(mockResolveOrgRollup).not.toHaveBeenCalled();
      expect(mockGetPlatformErrors).toHaveBeenCalledWith(expect.any(String), expect.any(String), 10);
    });
  });
  describe('GET /error-patterns (the tenant error report)', () => {
    const gatesOf = (path: string) => (router.stack.find((l: any) => l.route?.path === path)?.route?.stack ?? [])
      .slice(0, -1).map((s: any) => getRouteGates(s.handle) ?? [])
      .flat();

    it('carries no system-org / orgs:read gate — reports:read at the mount is the gate', () => {
      expect(gatesOf('/error-patterns')).toEqual([]);
      const stack = router.stack.find((l: any) => l.route?.path === '/error-patterns')?.route?.stack;
      expect(stack).toHaveLength(1);
    });

    it('reads the CALLER\'s org (never the cross-org operator read) and scrubs the pattern text', async () => {
      mockGetErrorCategories.mockResolvedValue([{
        category: 'unit_test',
        occurrences: 2,
        affected_pipelines: 1,
        last_seen: '2026-01-02',
        patterns: [{ error_pattern: 'login failed password=hunter2', occurrences: 2 }],
      }]);
      const handler = getHandler('/error-patterns');
      await handler({ query: { limit: '5', from: '2026-01-01', to: '2026-01-31' } }, {});

      expect(mockGetPlatformErrors).not.toHaveBeenCalled();
      expect(mockGetErrorCategories).toHaveBeenCalledWith('acme', '2026-01-01', '2026-01-31', 5, undefined);
      const body = (sendSuccess as any).mock.calls[0][2];
      expect(body.categories[0].patterns[0].error_pattern).not.toContain('hunter2');
      expect(body.categories[0]).toMatchObject({ category: 'unit_test', occurrences: 2 });
    });

    it('is rollup-aware for reports:rollup holders only', async () => {
      mockGetErrorCategories.mockResolvedValue([]);
      mockResolveOrgRollup.mockResolvedValue(['acme', 'team-1']);
      const handler = getHandler('/error-patterns');
      await handler({ query: { includeDescendants: 'true' }, user: { permissions: ['reports:read'] } }, {});
      expect(mockGetErrorCategories).toHaveBeenLastCalledWith('acme', expect.any(String), expect.any(String), 20, undefined);
      await handler({ query: { includeDescendants: 'true' }, user: { permissions: ['reports:read', 'reports:rollup'] } }, {});
      expect(mockGetErrorCategories).toHaveBeenLastCalledWith('acme', expect.any(String), expect.any(String), 20, ['acme', 'team-1']);
    });
  });

  describe('GET /flaky-stages and /flaky-stages/trend', () => {
    const featureOf = (path: string) => (router.stack.find((l: any) => l.route?.path === path)?.route?.stack ?? [])
      .map((s: any) => s.handle.__feature).filter(Boolean);

    it('the ranked list is free (no feature gate); the trend needs advanced_reporting', () => {
      expect(featureOf('/flaky-stages')).toEqual([]);
      expect(featureOf('/flaky-stages/trend')).toEqual(['advanced_reporting']);
      expect(featureOf('/dora/trend')).toEqual(['advanced_reporting']);
    });

    it('lists the org\'s flaky stages', async () => {
      mockGetFlakyStages.mockResolvedValue([{ pipeline_id: 'p1', stage_name: 'Build', flaky_runs: 2, runs: 4, flake_pct: 50 }]);
      const handler = getHandler('/flaky-stages');
      await handler({ query: { from: '2026-01-01', to: '2026-01-31' } }, {});
      expect(mockGetFlakyStages).toHaveBeenCalledWith('acme', '2026-01-01', '2026-01-31', undefined, 50);
      expect((sendSuccess as any).mock.calls[0][2]).toEqual({ stages: [expect.objectContaining({ flake_pct: 50 })] });
    });

    it('the trend honours interval, tz/weekStart and the (pipeline, stage) drill-down', async () => {
      mockGetFlakyStageTrend.mockResolvedValue([]);
      const handler = getHandler('/flaky-stages/trend');
      await handler({ query: { interval: 'day', tz: 'America/Chicago', weekStart: 'sunday', pipelineId: 'p1', stageName: 'Build' } }, {});
      expect(mockGetFlakyStageTrend).toHaveBeenCalledWith('acme', 'day', expect.any(String), expect.any(String), undefined,
        { tz: 'America/Chicago', weekStart: 'sunday', pipelineId: 'p1', stageName: 'Build' });
    });

    it('the trend 400s on an invalid interval or timezone and does not query', async () => {
      const handler = getHandler('/flaky-stages/trend');
      await handler({ query: { interval: 'year' } }, {});
      await handler({ query: { tz: 'Mars/Olympus_Mons' } }, {});
      expect(sendBadRequest).toHaveBeenCalledTimes(2);
      expect(mockGetFlakyStageTrend).not.toHaveBeenCalled();
    });
  });
});
