// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/scorecard-routes — the per-pipeline maturity scorecard route.
 * Focus: it threads the org's `incidentWindowHours` override into the DORA
 * compute so the scorecard's CFR/MTTR match what `/dora` shows for the same org.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn((_res: any, _code: number, data: any) => data);
const mockSendBadRequest = jest.fn<AnyFn>();
const mockSendEntityNotFound = jest.fn<AnyFn>();
const mockGetDoraMetrics = jest.fn<AnyFn>();
const mockGetIncidentSettings = jest.fn<AnyFn>();
const mockFindById = jest.fn<AnyFn>();
const mockFindPaginated = jest.fn<AnyFn>();
const mockOpenExposures = jest.fn<AnyFn>(async () => []);
const mockDryRun = jest.fn<AnyFn>(async () => ({ rulesEvaluated: 0, violations: [], warnings: [] }));
const rollupCacheStore = new Map<string, unknown>();
let viewer = 'user-1';

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn<AnyFn>(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // Records what each route demands, so the permission choice is asserted.
  requirePermission: (...perms: string[]) => Object.assign((_q: unknown, _r: unknown, next: () => void) => next(), { __perms: perms }),
  requireFeature: (flag: string) => Object.assign((_q: unknown, _r: unknown, next: () => void) => next(), { __feature: flag }),
  toComplianceAttributes: (p: unknown) => p,
  sendSuccess: mockSendSuccess,
  sendBadRequest: mockSendBadRequest,
  sendEntityNotFound: mockSendEntityNotFound,
  getParam: (params: Record<string, string>, key: string) => params[key],
  getServiceAuthHeader: () => 'Bearer svc',
  createComplianceClient: () => ({
    dryRunPipeline: (...a: unknown[]) => mockDryRun(...a),
  }),
  runConcurrent: async <T, R>(items: T[], _max: number, fn: (i: T) => Promise<R>) => Promise.all(items.map(fn)),
  // An in-memory stand-in for the Redis-backed cache, so reuse is observable.
  createCacheService: () => ({
    getOrSet: async (key: string, factory: () => Promise<unknown>) => {
      if (!rollupCacheStore.has(key)) rollupCacheStore.set(key, await factory());
      return rollupCacheStore.get(key);
    },
  }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: {
    getDoraMetrics: (...a: unknown[]) => mockGetDoraMetrics(...a),
    getReportingSettings: (...a: unknown[]) => mockGetIncidentSettings(...a),
  },
  viewerCacheSegment: () => viewer,
  openExposures: (...a: unknown[]) => mockOpenExposures(...a),
}));

jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: {
    findById: (...a: unknown[]) => mockFindById(...a),
    findPaginated: (...a: unknown[]) => mockFindPaginated(...a),
  },
}));

const { createScorecardRoutes } = await import('../src/routes/scorecard-routes.js');

const sampleDora = {
  window: { from: '', to: '' },
  filters: { pipelineId: null, environment: null },
  headline: 'production',
  environments: [{
    environment: 'production',
    deploymentFrequency: { deployments: 5, perDay: 0.2, level: 'high' },
    leadTime: { deployments: 5, medianSeconds: 100, level: 'elite' },
    changeFailureRate: { rate: 0, deployTimeFailures: 0, postDeployFailures: 0, attempts: 5, level: 'elite' },
  }],
  meanTimeToRestore: { incidents: 0, restored: 0, medianSeconds: null, level: null },
  coverage: { registered: 1, deploying: 1, withoutDeploys: 0 },
};

describe('GET /:id/scorecard', () => {
  let router: any;
  const res = () => ({ status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() });
  const handler = () => {
    const stack = router.stack.find((l: any) => l.route?.path === '/:id/scorecard')?.route?.stack;
    return stack[stack.length - 1].handle;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindById.mockResolvedValue({ id: 'p1', name: 'P1' });
    mockGetDoraMetrics.mockResolvedValue(sampleDora);
    router = createScorecardRoutes();
  });

  it('threads the org incidentWindowHours OVERRIDE into the DORA compute', async () => {
    mockGetIncidentSettings.mockResolvedValue({ incidentWindowHours: 72, defaultWindowHours: 24 });
    await handler()({ params: { id: 'p1' } }, res());
    expect(mockGetDoraMetrics).toHaveBeenCalledWith(
      'acme', expect.any(String), expect.any(String), ['acme'],
      { pipelineId: 'p1', incidentWindowHours: 72 },
    );
  });

  it('passes undefined when the org has NO incident-window override (env default)', async () => {
    mockGetIncidentSettings.mockResolvedValue({ incidentWindowHours: null, defaultWindowHours: 24 });
    await handler()({ params: { id: 'p1' } }, res());
    expect(mockGetDoraMetrics).toHaveBeenCalledWith(
      'acme', expect.any(String), expect.any(String), ['acme'],
      { pipelineId: 'p1', incidentWindowHours: undefined },
    );
  });

  it('scores security against the ROW id, so a mixed-case path id still sees its exposures', async () => {
    const lower = 'abcdef00-0000-4000-8000-0000000000ab';
    mockFindById.mockResolvedValue({ id: lower, name: 'P1' });
    mockGetIncidentSettings.mockResolvedValue({ incidentWindowHours: null, defaultWindowHours: 24 });
    mockOpenExposures.mockResolvedValueOnce([{ pipelineId: lower, criticalCount: 2, highCount: 1, topFindings: [] }]);
    await handler()({ params: { id: lower.toUpperCase() } }, res());
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.scorecard.security.exposures).toMatchObject({ count: 1, critical: 2, high: 1 });
  });

  it('returns the scorecard consuming the response deploymentFrequency.level', async () => {
    mockGetIncidentSettings.mockResolvedValue({ incidentWindowHours: null, defaultWindowHours: 24 });
    await handler()({ params: { id: 'p1' } }, res());
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.scorecard.dora.deploymentFrequency).toBe('high');
  });
});

describe('GET /scorecard (org-wide roll-up)', () => {
  let router: any;
  const res = () => ({ status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() });
  const handler = () => {
    const stack = router.stack.find((l: any) => l.route?.path === '/scorecard')?.route?.stack;
    return stack[stack.length - 1].handle;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDoraMetrics.mockResolvedValue(sampleDora);
    mockGetIncidentSettings.mockResolvedValue({ incidentWindowHours: null, defaultWindowHours: 24 });
    rollupCacheStore.clear();
    viewer = 'user-1';
    router = createScorecardRoutes();
  });

  it('scores every org pipeline and returns a ranked leaderboard + aggregate stats', async () => {
    mockFindPaginated.mockResolvedValue({
      data: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
      hasMore: false,
      limit: 51,
      offset: 0,
    });

    await handler()({ params: {} }, res());

    // One DORA compute per pipeline.
    expect(mockGetDoraMetrics).toHaveBeenCalledTimes(2);
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.rollup.pipelineCount).toBe(2);
    expect(payload.rollup.leaderboard).toHaveLength(2);
    expect(payload.rollup.leaderboard.map((c: any) => c.name)).toEqual(expect.arrayContaining(['P1', 'P2']));
    // Leaderboard is sorted score-desc.
    const scores = payload.rollup.leaderboard.map((c: any) => c.score ?? -1);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
    expect(typeof payload.rollup.gradeDistribution).toBe('object');
    expect(payload.rollup.truncated).toBe(false);
  });

  it('REGRESSION: one pipeline whose DORA compute fails does NOT fail the whole roll-up', async () => {
    // Only the COMPLIANCE half of computeScorecard was fail-soft; the DORA await
    // was unguarded, so a single bad pipeline rejected the entire roll-up and the
    // Scorecard tab rendered "Internal server error" with nothing at all.
    mockFindPaginated.mockResolvedValue({
      data: [{ id: 'p1', name: 'P1' }, { id: 'bad', name: 'Bad' }, { id: 'p3', name: 'P3' }],
      hasMore: false,
      limit: 51,
      offset: 0,
    });
    mockGetDoraMetrics.mockImplementation(async (_org: string, _f: string, _t: string, _ids: string[], opts: any) => {
      if (opts?.pipelineId === 'bad') throw new Error('relation "dora_events" does not exist');
      return sampleDora;
    });

    const r = res();
    await handler()({ params: {} }, r);

    // The page still renders, with every pipeline present.
    expect(mockSendSuccess).toHaveBeenCalled();
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.rollup.pipelineCount).toBe(3);
    expect(payload.rollup.leaderboard).toHaveLength(3);
  });

  it('marks the failed pipeline unavailable and counts it, rather than scoring it F', async () => {
    mockFindPaginated.mockResolvedValue({
      data: [{ id: 'p1', name: 'P1' }, { id: 'bad', name: 'Bad' }],
      hasMore: false,
      limit: 51,
      offset: 0,
    });
    mockGetDoraMetrics.mockImplementation(async (_o: string, _f: string, _t: string, _i: string[], opts: any) => {
      if (opts?.pipelineId === 'bad') throw new Error('boom');
      return sampleDora;
    });

    await handler()({ params: {} }, res());
    const [, , payload] = mockSendSuccess.mock.calls[0];

    expect(payload.rollup.failed).toBe(1);
    const bad = payload.rollup.leaderboard.find((c: any) => c.pipelineId === 'bad');
    // Not measured — never confused with a genuinely poor score.
    expect(bad.unavailable).toBe(true);
    expect(bad.score).toBeNull();
    expect(bad.grade).toBe('N/A');
    // ...and it sinks to the bottom, below the scored pipeline.
    expect(payload.rollup.leaderboard[payload.rollup.leaderboard.length - 1].pipelineId).toBe('bad');
  });

  it('excludes an unscorable pipeline from the average', async () => {
    mockFindPaginated.mockResolvedValue({
      data: [{ id: 'p1', name: 'P1' }, { id: 'bad', name: 'Bad' }],
      hasMore: false,
      limit: 51,
      offset: 0,
    });
    mockGetDoraMetrics.mockImplementation(async (_o: string, _f: string, _t: string, _i: string[], opts: any) => {
      if (opts?.pipelineId === 'bad') throw new Error('boom');
      return sampleDora;
    });

    await handler()({ params: {} }, res());
    const [, , payload] = mockSendSuccess.mock.calls[0];

    // `scored` counts only real scores, so the average isn't dragged by a gap.
    expect(payload.rollup.scored).toBe(1);
    expect(payload.rollup.averageScore).not.toBeNull();
  });

  it('still returns a page when EVERY pipeline fails to score', async () => {
    mockFindPaginated.mockResolvedValue({
      data: [{ id: 'a' }, { id: 'b' }], hasMore: false, limit: 51, offset: 0,
    });
    mockGetDoraMetrics.mockRejectedValue(new Error('reporting down'));

    await handler()({ params: {} }, res());
    const [, , payload] = mockSendSuccess.mock.calls[0];

    expect(payload.rollup.failed).toBe(2);
    expect(payload.rollup.scored).toBe(0);
    expect(payload.rollup.averageScore).toBeNull();
  });

  it('flags truncation when the org has more pipelines than the cap', async () => {
    // hasMore true ⇒ the org exceeds the per-roll-up cap.
    mockFindPaginated.mockResolvedValue({ data: [{ id: 'p1', name: 'P1' }], hasMore: true, limit: 51, offset: 0 });
    await handler()({ params: {} }, res());
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.rollup.truncated).toBe(true);
  });

  // Q7: the roll-up stopped at the first 50 pipelines in id order, mixed in the
  // system samples, had no next page and recomputed every request.
  describe('paging, filter and reuse', () => {
    const page = (data: unknown[], hasMore: boolean, total?: number) => ({ data, hasMore, limit: 50, offset: 0, ...(total !== undefined && { total }) });

    it('lists ONLY the org\'s own pipelines, newest-changed first, with the total', async () => {
      mockFindPaginated.mockResolvedValue(page([{ id: 'p1' }], false, 1));
      await handler()({ params: {}, query: {} }, res());
      expect(mockFindPaginated).toHaveBeenCalledWith(
        { orgId: 'acme' },
        'acme',
        { limit: 50, offset: 0, sortBy: 'updatedAt', sortOrder: 'desc', includeTotal: true },
      );
    });

    it('pages with offset/limit and reports where the next page starts', async () => {
      mockFindPaginated.mockResolvedValue(page([{ id: 'p11' }, { id: 'p12' }], true, 30));
      await handler()({ params: {}, query: { offset: '10', limit: '2' } }, res());
      expect(mockFindPaginated.mock.calls[0][2]).toEqual(expect.objectContaining({ offset: 10, limit: 2 }));
      const [, , payload] = mockSendSuccess.mock.calls[0];
      expect(payload.rollup.pagination).toEqual({ offset: 10, limit: 2, total: 30, hasMore: true, nextOffset: 12 });
      expect(payload.rollup.truncated).toBe(true);
    });

    it('narrows by project and pipelineName', async () => {
      mockFindPaginated.mockResolvedValue(page([], false, 0));
      await handler()({ params: {}, query: { project: 'web', pipelineName: 'api' } }, res());
      expect(mockFindPaginated.mock.calls[0][0]).toEqual({ orgId: 'acme', project: 'web', pipelineName: 'api' });
      const [, , payload] = mockSendSuccess.mock.calls[0];
      expect(payload.rollup.pagination.nextOffset).toBeNull();
    });

    it('400s a limit past the cap or a negative offset, computing nothing', async () => {
      for (const query of [{ limit: '51' }, { offset: '-1' }, { limit: '0' }]) {
        await handler()({ params: {}, query }, res());
      }
      expect(mockSendBadRequest).toHaveBeenCalledTimes(3);
      expect(mockFindPaginated).not.toHaveBeenCalled();
    });

    it('reuses a computed page for the same viewer, and never across viewers', async () => {
      mockFindPaginated.mockResolvedValue(page([{ id: 'p1' }], false, 1));
      await handler()({ params: {}, query: {} }, res());
      await handler()({ params: {}, query: {} }, res());
      expect(mockGetDoraMetrics).toHaveBeenCalledTimes(1);
      // A different viewer may see different (private) rows: its own compute.
      viewer = 'user-2';
      await handler()({ params: {}, query: {} }, res());
      expect(mockGetDoraMetrics).toHaveBeenCalledTimes(2);
      // A different page is a different key too.
      await handler()({ params: {}, query: { offset: '50' } }, res());
      expect(mockFindPaginated).toHaveBeenCalledTimes(3);
    });
  });
});

const DAY = 86_400_000;
const settings = (over: Record<string, unknown> = {}) => ({
  incidentWindowHours: null,
  defaultWindowHours: 24,
  eventRetentionDays: null,
  doraRetentionDays: null,
  defaultEventRetentionDays: 30,
  defaultDoraRetentionDays: 180,
  ...over,
});
const routeHandler = (router: any, path: string) => {
  const stack = router.stack.find((l: any) => l.route?.path === path)?.route?.stack;
  if (!stack) throw new Error(`no route ${path}`);
  return stack[stack.length - 1].handle;
};
const guardsOf = (router: any, path: string) => {
  const stack = router.stack.find((l: any) => l.route?.path === path)?.route?.stack ?? [];
  return {
    perms: stack.flatMap((l: any) => l.handle.__perms ?? []),
    features: stack.map((l: any) => l.handle.__feature).filter(Boolean),
  };
};
const resStub = () => ({ status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() });

/**
 * A DORA result whose band depends on the window, so a history that scored the
 * wrong window (or the same window twice) would show it.
 */
function doraFor(from: string) {
  const day = new Date(from).getUTCDate();
  const level = (['elite', 'high', 'medium', 'low'] as const)[day % 4];
  return {
    ...sampleDora,
    environments: [{ ...sampleDora.environments[0], deploymentFrequency: { deployments: 5, perDay: 0.2, level }, leadTime: { deployments: 5, medianSeconds: 100, level } }],
  };
}

describe('scorecard range (?from&to&tz)', () => {
  let router: any;
  beforeEach(() => {
    jest.clearAllMocks();
    rollupCacheStore.clear();
    mockFindById.mockResolvedValue({ id: 'p1', name: 'P1' });
    mockGetDoraMetrics.mockResolvedValue(sampleDora);
    mockGetIncidentSettings.mockResolvedValue(settings());
    router = createScorecardRoutes();
  });

  it('with NO params keeps the trailing-30-day window and the response shape', async () => {
    await routeHandler(router, '/:id/scorecard')({ params: { id: 'p1' }, query: {} }, resStub());
    const [, from, to] = mockGetDoraMetrics.mock.calls[0] as [string, string, string];
    expect(Date.parse(to) - Date.parse(from)).toBe(30 * DAY);
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(Object.keys(payload)).toEqual(['scorecard']);
  });

  it('scores the requested window', async () => {
    const from = new Date(Date.now() - 10 * DAY).toISOString();
    const to = new Date(Date.now() - 3 * DAY).toISOString();
    await routeHandler(router, '/:id/scorecard')({ params: { id: 'p1' }, query: { from, to, tz: 'America/Chicago' } }, resStub());
    expect(mockGetDoraMetrics).toHaveBeenCalledWith('acme', from, to, ['acme'], expect.objectContaining({ pipelineId: 'p1' }));
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.scorecard.computedAt).toBe(to);
  });

  it('caps the width at the DORA retention and floors from at its horizon', async () => {
    mockGetIncidentSettings.mockResolvedValue(settings({ doraRetentionDays: 20 }));
    const wide = { from: new Date(Date.now() - 40 * DAY).toISOString(), to: new Date().toISOString() };
    await routeHandler(router, '/:id/scorecard')({ params: { id: 'p1' }, query: wide }, resStub());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/exceeds maximum of 20 days/), expect.anything());
    expect(mockGetDoraMetrics).not.toHaveBeenCalled();

    const old = { from: new Date(Date.now() - 25 * DAY).toISOString(), to: new Date(Date.now() - 10 * DAY).toISOString() };
    await routeHandler(router, '/:id/scorecard')({ params: { id: 'p1' }, query: old }, resStub());
    const [, from] = mockGetDoraMetrics.mock.calls[0] as [string, string];
    expect(Date.parse(from)).toBeGreaterThan(Date.parse(old.from));
    expect(Math.abs(Date.parse(from) - (Date.now() - 20 * DAY))).toBeLessThan(5_000);
  });

  it('reads the retention of the account ROOT for a team caller', async () => {
    await routeHandler(router, '/:id/scorecard')({
      params: { id: 'p1' }, query: {}, user: { organizationId: 'acme', rootOrganizationId: 'root-1' },
    }, resStub());
    expect(mockGetIncidentSettings).toHaveBeenCalledWith('acme', 'root-1');
  });

  it('400s a bad tz or an inverted range', async () => {
    await routeHandler(router, '/:id/scorecard')({ params: { id: 'p1' }, query: { tz: 'Mars/Olympus' } }, resStub());
    const now = Date.now();
    await routeHandler(router, '/scorecard')({ params: {}, query: { from: new Date(now).toISOString(), to: new Date(now - DAY).toISOString() } }, resStub());
    expect(mockSendBadRequest).toHaveBeenCalledTimes(2);
    expect(mockGetDoraMetrics).not.toHaveBeenCalled();
  });

  it('the roll-up scores the requested window, cached apart from the default', async () => {
    mockFindPaginated.mockResolvedValue({ data: [{ id: 'p1', name: 'P1' }], hasMore: false, total: 1 });
    await routeHandler(router, '/scorecard')({ params: {}, query: {} }, resStub());
    const from = new Date(Date.now() - 7 * DAY).toISOString();
    const to = new Date(Date.now() - DAY).toISOString();
    await routeHandler(router, '/scorecard')({ params: {}, query: { from, to } }, resStub());
    expect(mockGetDoraMetrics).toHaveBeenCalledTimes(2);
    expect(mockGetDoraMetrics.mock.calls[1].slice(1, 3)).toEqual([from, to]);
    const [, , payload] = mockSendSuccess.mock.calls[1];
    expect(payload.rollup.computedAt).toBe(to);
  });
});

describe('grade history', () => {
  let router: any;
  beforeEach(() => {
    jest.clearAllMocks();
    rollupCacheStore.clear();
    viewer = 'user-1';
    mockFindById.mockResolvedValue({ id: 'p1', name: 'P1' });
    mockGetIncidentSettings.mockResolvedValue(settings());
    mockGetDoraMetrics.mockImplementation(async (_o: string, from: string) => doraFor(from));
    mockDryRun.mockResolvedValue({ rulesEvaluated: 4, violations: [{}], warnings: [] });
    router = createScorecardRoutes();
  });

  it('per pipeline: every window scores exactly what the scorecard does for that window', async () => {
    await routeHandler(router, '/:id/scorecard/history')({ params: { id: 'p1' }, query: { interval: 'week', periods: '6', tz: 'UTC' } }, resStub());
    const [, , payload] = mockSendSuccess.mock.calls[0];
    const { history } = payload;
    expect(history).toMatchObject({ pipelineId: 'p1', interval: 'week', tz: 'UTC', weekStart: 'monday' });
    expect(history.points).toHaveLength(6);
    // The windows differ, so a constant series would mean one window scored N times.
    expect(new Set(history.points.map((p: any) => p.score)).size).toBeGreaterThan(1);

    for (const point of history.points) {
      mockSendSuccess.mockClear();
      await routeHandler(router, '/:id/scorecard')({ params: { id: 'p1' }, query: { from: point.from, to: point.to } }, resStub());
      const [, , single] = mockSendSuccess.mock.calls[0];
      expect([point.label, point.score, point.grade]).toEqual([point.label, single.scorecard.score, single.scorecard.grade]);
    }
  });

  it('per pipeline: runs the compliance dry-run ONCE, not once per window', async () => {
    await routeHandler(router, '/:id/scorecard/history')({ params: { id: 'p1' }, query: { interval: 'month', periods: '3' } }, resStub());
    expect(mockGetDoraMetrics).toHaveBeenCalledTimes(3);
    expect(mockDryRun).toHaveBeenCalledTimes(1);
  });

  it('per pipeline: 400s periods past the cap and an unknown interval, computing nothing', async () => {
    for (const query of [{ periods: '13' }, { periods: '0' }, { interval: 'day' }, { tz: 'Nope/Nope' }, { weekStart: 'friday' }]) {
      await routeHandler(router, '/:id/scorecard/history')({ params: { id: 'p1' }, query }, resStub());
    }
    expect(mockSendBadRequest).toHaveBeenCalledTimes(5);
    expect(mockGetDoraMetrics).not.toHaveBeenCalled();
  });

  it('per pipeline: one window whose DORA fails is a gap, not a 500', async () => {
    let n = 0;
    mockGetDoraMetrics.mockImplementation(async (_o: string, from: string) => {
      n += 1;
      if (n === 2) throw new Error('boom');
      return doraFor(from);
    });
    await routeHandler(router, '/:id/scorecard/history')({ params: { id: 'p1' }, query: { periods: '3' } }, resStub());
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.history.points.filter((p: any) => p.unavailable)).toHaveLength(1);
    expect(payload.history.points.filter((p: any) => p.score !== null)).toHaveLength(2);
  });

  it('per pipeline: 404s an unknown pipeline', async () => {
    mockFindById.mockResolvedValue(null);
    await routeHandler(router, '/:id/scorecard/history')({ params: { id: 'nope' }, query: {} }, resStub());
    expect(mockSendEntityNotFound).toHaveBeenCalled();
  });

  it('org-wide: each window\'s average equals the roll-up\'s average for that window, per pipeline too', async () => {
    mockFindPaginated.mockResolvedValue({ data: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], hasMore: false, total: 2 });
    mockGetDoraMetrics.mockImplementation(async (_o: string, from: string, _t: string, _i: string[], opts: any) => (
      opts.pipelineId === 'p2' ? sampleDora : doraFor(from)
    ));
    await routeHandler(router, '/scorecard/history')({ params: {}, query: { interval: 'week', periods: '4' } }, resStub());
    const [, , payload] = mockSendSuccess.mock.calls[0];
    const { history } = payload;
    expect(history.windows).toHaveLength(4);
    expect(history.pipelines.map((p: any) => p.name)).toEqual(['P1', 'P2']);

    for (const [i, w] of history.windows.entries()) {
      mockSendSuccess.mockClear();
      await routeHandler(router, '/scorecard')({ params: {}, query: { from: w.from, to: w.to } }, resStub());
      const [, , single] = mockSendSuccess.mock.calls[0];
      expect([w.label, w.averageScore, w.grade]).toEqual([w.label, single.rollup.averageScore, gradeOf(single.rollup.averageScore)]);
      for (const p of history.pipelines) {
        const card = single.rollup.leaderboard.find((c: any) => c.pipelineId === p.pipelineId);
        expect([w.label, p.pipelineId, p.points[i].score]).toEqual([w.label, p.pipelineId, card.score]);
      }
    }
  });

  it('org-wide: reuses a computed history per viewer and query', async () => {
    mockFindPaginated.mockResolvedValue({ data: [{ id: 'p1' }], hasMore: false, total: 1 });
    await routeHandler(router, '/scorecard/history')({ params: {}, query: { periods: '2' } }, resStub());
    await routeHandler(router, '/scorecard/history')({ params: {}, query: { periods: '2' } }, resStub());
    expect(mockGetDoraMetrics).toHaveBeenCalledTimes(2);
    viewer = 'user-2';
    await routeHandler(router, '/scorecard/history')({ params: {}, query: { periods: '2' } }, resStub());
    expect(mockGetDoraMetrics).toHaveBeenCalledTimes(4);
  });
});

/** The grade ladder (mirrors gradeForScore) — the org history grades the average. */
function gradeOf(score: number | null): string {
  if (score === null) return 'N/A';
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 45) return 'D';
  return 'F';
}

describe('scorecard permissions', () => {
  const router = () => createScorecardRoutes() as any;

  it('per-pipeline card + its history stay on pipelines:read (a pipelines:read-only role sees the card on the pipeline page)', () => {
    for (const path of ['/:id/scorecard', '/:id/scorecard/history']) {
      expect([path, guardsOf(router(), path)]).toEqual([path, { perms: ['pipelines:read'], features: ['advanced_reporting'] }]);
    }
  });

  it('the org leaderboard + its history are REPORTING data: reports:read', () => {
    for (const path of ['/scorecard', '/scorecard/history']) {
      expect([path, guardsOf(router(), path)]).toEqual([path, { perms: ['reports:read'], features: ['advanced_reporting'] }]);
    }
  });
});
