// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/scorecard-routes — the per-pipeline maturity scorecard route.
 * Focus: it threads the org's `incidentWindowHours` override into the DORA
 * compute so the scorecard's CFR/MTTR match what `/dora` shows for the same org.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn((_res: any, _code: number, data: any) => data);
const mockSendBadRequest = jest.fn<AnyFn>();
const mockSendEntityNotFound = jest.fn<AnyFn>();
const mockGetDoraMetrics = jest.fn<AnyFn>();
const mockGetIncidentSettings = jest.fn<AnyFn>();
const mockFindById = jest.fn<AnyFn>();
const mockFindPaginated = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn<AnyFn>(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
  meterQuotaOnSuccess: (_qs: unknown, quotaType: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { meters: quotaType }),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  toComplianceAttributes: (p: unknown) => p,
  sendSuccess: mockSendSuccess,
  sendBadRequest: mockSendBadRequest,
  sendEntityNotFound: mockSendEntityNotFound,
  getParam: (params: Record<string, string>, key: string) => params[key],
  getServiceAuthHeader: () => 'Bearer svc',
  createComplianceClient: () => ({
    dryRunPipeline: async () => ({ rulesEvaluated: 0, violations: [], warnings: [] }),
  }),
  runConcurrent: async <T, R>(items: T[], _max: number, fn: (i: T) => Promise<R>) => Promise.all(items.map(fn)),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: {
    getDoraMetrics: (...a: unknown[]) => mockGetDoraMetrics(...a),
    getReportingSettings: (...a: unknown[]) => mockGetIncidentSettings(...a),
  },
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
    router = createScorecardRoutes({} as any);
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
    router = createScorecardRoutes({} as any);
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
});
