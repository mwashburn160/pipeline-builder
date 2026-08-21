// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/scorecard-routes — the per-pipeline maturity scorecard route.
 * Focus: it threads the org's `incidentWindowHours` override into the DORA
 * compute so the scorecard's CFR/MTTR match what `/dora` shows for the same org.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn((_res: any, _code: number, data: any) => data);
const mockSendBadRequest = jest.fn();
const mockSendEntityNotFound = jest.fn();
const mockGetDoraMetrics = jest.fn<(...a: unknown[]) => Promise<any>>();
const mockGetIncidentSettings = jest.fn<(...a: unknown[]) => Promise<any>>();
const mockFindById = jest.fn<(...a: unknown[]) => Promise<any>>();
const mockIncrementQuota = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
  incrementQuotaFromCtx: (...a: unknown[]) => mockIncrementQuota(...a),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendBadRequest: mockSendBadRequest,
  sendEntityNotFound: mockSendEntityNotFound,
  getParam: (params: Record<string, string>, key: string) => params[key],
  getServiceAuthHeader: () => 'Bearer svc',
  createComplianceClient: () => ({
    dryRunPipeline: async () => ({ rulesEvaluated: 0, violations: [], warnings: [] }),
  }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  reportingService: {
    getDoraMetrics: (...a: unknown[]) => mockGetDoraMetrics(...a),
    getIncidentSettings: (...a: unknown[]) => mockGetIncidentSettings(...a),
  },
}));

jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: { findById: (...a: unknown[]) => mockFindById(...a) },
  toComplianceAttributes: (p: unknown) => p,
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
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
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
