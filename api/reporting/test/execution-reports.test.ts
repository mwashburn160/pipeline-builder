// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for execution report routes.
 */

const mockGetExecutionCount = jest.fn();
const mockGetSuccessRate = jest.fn();
const mockGetExecutionTimeline = jest.fn();
const mockGetAverageDuration = jest.fn();
const mockGetStageFailures = jest.fn();
const mockGetStageBottlenecks = jest.fn();
const mockGetActionFailures = jest.fn();
const mockGetErrors = jest.fn();

jest.mock('@mwashburn160/api-core', () => ({
  sendSuccess: jest.fn(),
  sendBadRequest: jest.fn(),
  ErrorCode: { VALIDATION_ERROR: 'VALIDATION_ERROR' },
  createLogger: () => ({ info: jest.fn(), debug: jest.fn() }),
}));

jest.mock('@mwashburn160/api-server', () => ({
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.mock('@mwashburn160/pipeline-data', () => ({
  reportingService: {
    getExecutionCount: mockGetExecutionCount,
    getSuccessRate: mockGetSuccessRate,
    getExecutionTimeline: mockGetExecutionTimeline,
    getAverageDuration: mockGetAverageDuration,
    getStageFailures: mockGetStageFailures,
    getStageBottlenecks: mockGetStageBottlenecks,
    getActionFailures: mockGetActionFailures,
    getErrors: mockGetErrors,
  },
}));

import { sendSuccess, sendBadRequest } from '@mwashburn160/api-core';
import { createExecutionReportRoutes } from '../src/routes/execution-reports';

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

      expect(mockGetExecutionCount).toHaveBeenCalledWith('acme');
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

      expect(mockGetSuccessRate).toHaveBeenCalledWith('acme', 'month', '2026-01-01', '2026-03-15');
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

      expect(mockGetSuccessRate).toHaveBeenCalledWith('acme', 'week', expect.any(String), expect.any(String));
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
      const req = { query: { limit: '10' } };
      const res = {};

      await handler(req, res);

      expect(mockGetErrors).toHaveBeenCalledWith('acme', expect.any(String), expect.any(String), 10);
    });
  });
});
