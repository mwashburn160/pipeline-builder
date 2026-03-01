/**
 * Tests for routes/queue-status.
 *
 * Mocks BullMQ Queue.getJobCounts() and verifies the route
 * returns queue metrics for admin users and rejects non-admins.
 */

const mockGetJobCounts = jest.fn();

jest.mock('../src/queue/plugin-build-queue', () => ({
  getQueue: () => ({ getJobCounts: mockGetJobCounts }),
}));

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
  }),
  isSystemAdmin: jest.fn(),
  sendSuccess: jest.fn((res: any, status: number, data: any) => {
    res.status(status).json({ success: true, statusCode: status, data });
  }),
  sendError: jest.fn((res: any, status: number, message: string) => {
    res.status(status).json({ success: false, statusCode: status, message });
  }),
  ErrorCode: { INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS' },
}));

jest.mock('@mwashburn160/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any, _next: any) => {
    const ctx = {
      requestId: 'test-req', log: jest.fn(),
    };
    (req as any).__ctx = ctx;
    await handler({ req, res, ctx, orgId: req.headers['x-org-id'] || 'system', userId: 'user-1' });
  },
}));

import { isSystemAdmin } from '@mwashburn160/api-core';
import { createQueueStatusRoutes } from '../src/routes/queue-status';

// Minimal Express-like mocks
function createMockReqRes() {
  const req = {
    headers: { 'x-org-id': 'system' },
    method: 'GET',
    path: '/status',
  } as any;
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as any;
  return { req, res, json, status };
}

describe('queue-status route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return job counts for admin users', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(true);
    mockGetJobCounts.mockResolvedValue({
      waiting: 3, active: 1, completed: 10, failed: 2, delayed: 0, paused: 0,
    });

    const router = createQueueStatusRoutes();
    const handler = (router.stack as any)[0].route.stack[0].handle;

    const { req, res, json } = createMockReqRes();
    await handler(req, res, jest.fn());

    expect(mockGetJobCounts).toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      statusCode: 200,
      data: { waiting: 3, active: 1, completed: 10, failed: 2, delayed: 0 },
    }));
  });

  it('should reject non-admin users with 403', async () => {
    (isSystemAdmin as jest.Mock).mockReturnValue(false);

    const router = createQueueStatusRoutes();
    const handler = (router.stack as any)[0].route.stack[0].handle;

    const { req, res, json } = createMockReqRes();
    await handler(req, res, jest.fn());

    expect(mockGetJobCounts).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      statusCode: 403,
    }));
  });
});
