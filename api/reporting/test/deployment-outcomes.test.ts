// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /reports/deployments/:executionId/outcome — the post-deploy
 * mark failed/restored write that feeds DORA post-deploy CFR + real MTTR.
 *
 * api#5 anti-forgery: `at` is bounded to `[now − doraRetention, now]` and a
 * supplied `environment` must be a REAL observed deploy env for the org, so a
 * user can't manufacture a phantom environment card.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendError = jest.fn((_res: any, code: number, msg: string) => ({ error: msg, code }));
const mockSendBadRequest = jest.fn((_res: any, msg: string, _code?: string) => msg);
const mockSendSuccess = jest.fn((_res: any, _code: number, data: any) => data);
const mockRecordOutcome = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockGetSettings = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockGetEnvironments = jest.fn<(...a: unknown[]) => Promise<string[]>>();

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme', userId: 'user-1' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendBadRequest: mockSendBadRequest,
  sendError: mockSendError,
  // helpers.ts (transitively pulled via retention-cap.ts) links userHasPermission.
  userHasPermission: jest.fn(() => false),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  reportingService: {
    recordDeploymentOutcome: (...a: unknown[]) => mockRecordOutcome(...a),
    getIncidentSettings: (...a: unknown[]) => mockGetSettings(...a),
    getReportEnvironments: (...a: unknown[]) => mockGetEnvironments(...a),
  },
}));

// deployment-outcomes.ts → retention-cap.ts → helpers.ts imports `Config` from
// pipeline-core; stub it so the full config graph (aws-cdk-lib, etc.) stays out.
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }) },
}));

const { createDeploymentOutcomeRoutes } = await import('../src/routes/deployment-outcomes.js');

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe('POST /reports/deployments/:executionId/outcome', () => {
  let router: any;
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  const getHandler = () => router.stack.find((l: any) => l.route?.path === '/:executionId/outcome')?.route?.stack[0]?.handle;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default org: bounded DORA retention (180d), 'production' is a real deploy env.
    mockGetSettings.mockResolvedValue({
      incidentWindowHours: null, defaultWindowHours: 24,
      eventRetentionDays: null, doraRetentionDays: null,
      defaultEventRetentionDays: 30, defaultDoraRetentionDays: 180,
    });
    mockGetEnvironments.mockResolvedValue(['production', 'staging']);
    router = createDeploymentOutcomeRoutes();
  });

  it('records a valid failed outcome for a real env within retention', async () => {
    const at = iso(10 * DAY);
    await getHandler()({ params: { executionId: 'exec-1' }, body: { outcome: 'failed', at, environment: 'production' } }, res());
    expect(mockRecordOutcome).toHaveBeenCalledWith('acme', 'exec-1', { outcome: 'failed', at, environment: 'production' });
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { executionId: 'exec-1', outcome: 'failed' });
  });

  it('records a restored outcome without an environment (no env validation)', async () => {
    const at = iso(9 * DAY);
    await getHandler()({ params: { executionId: 'exec-2' }, body: { outcome: 'restored', at } }, res());
    expect(mockGetEnvironments).not.toHaveBeenCalled();
    expect(mockRecordOutcome).toHaveBeenCalledWith('acme', 'exec-2', { outcome: 'restored', at });
  });

  it('400s an unknown outcome and does not write', async () => {
    await getHandler()({ params: { executionId: 'exec-3' }, body: { outcome: 'exploded', at: iso(DAY) } }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'VALIDATION_ERROR');
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it('400s a missing/invalid `at` timestamp and does not write', async () => {
    await getHandler()({ params: { executionId: 'exec-4' }, body: { outcome: 'failed' } }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'VALIDATION_ERROR');
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it('400s when executionId is missing', async () => {
    await getHandler()({ params: {}, body: { outcome: 'failed', at: iso(DAY) } }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('executionId'), 'VALIDATION_ERROR');
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it('400s a FUTURE `at` and does not write', async () => {
    const at = new Date(Date.now() + 2 * DAY).toISOString();
    await getHandler()({ params: { executionId: 'exec-5' }, body: { outcome: 'failed', at, environment: 'production' } }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('future'), 'VALIDATION_ERROR');
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it('400s an `at` older than the DORA retention window and does not write', async () => {
    const at = iso(300 * DAY); // > 180-day dora retention
    await getHandler()({ params: { executionId: 'exec-6' }, body: { outcome: 'failed', at, environment: 'production' } }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('retention'), 'VALIDATION_ERROR');
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it('400s an UNKNOWN environment (phantom-env forgery blocked) and does not write', async () => {
    const at = iso(5 * DAY);
    await getHandler()({ params: { executionId: 'exec-7' }, body: { outcome: 'failed', at, environment: 'ghost-env' } }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Unknown deploy environment'), 'VALIDATION_ERROR');
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it('an unlimited (-1) org accepts an ancient `at` (no retention floor)', async () => {
    mockGetSettings.mockResolvedValue({
      incidentWindowHours: null, defaultWindowHours: 24,
      eventRetentionDays: -1, doraRetentionDays: -1,
      defaultEventRetentionDays: 30, defaultDoraRetentionDays: 180,
    });
    const at = iso(3000 * DAY);
    await getHandler()({ params: { executionId: 'exec-8' }, body: { outcome: 'failed', at, environment: 'production' } }, res());
    expect(mockRecordOutcome).toHaveBeenCalledWith('acme', 'exec-8', { outcome: 'failed', at, environment: 'production' });
  });
});
