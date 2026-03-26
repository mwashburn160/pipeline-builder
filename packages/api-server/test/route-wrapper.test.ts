// Mock api-core before imports
jest.mock('@mwashburn160/api-core', () => ({
  AppError: class AppError extends Error {
    statusCode: number;
    code: string;
    constructor(statusCode: number, code: string, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
      this.name = 'AppError';
    }
  },
  errorMessage: jest.fn((err: unknown) =>
    err instanceof Error ? err.message : String(err),
  ),
  sendError: jest.fn(),
  sendBadRequest: jest.fn(),
  sendInternalError: jest.fn(),
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
}));

// Mock get-context to control behavior
jest.mock('../src/api/get-context', () => ({
  getContext: jest.fn(),
}));

import {
  AppError,
  sendError,
  sendBadRequest,
  sendInternalError,
} from '@mwashburn160/api-core';
import { getContext } from '../src/api/get-context';
import { withRoute } from '../src/api/route-wrapper';

function mockReq(): any {
  return { headers: {}, params: {}, query: {} };
}

function mockRes(): any {
  const res: any = { headersSent: false };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function mockContext(orgId?: string, userId?: string) {
  return {
    requestId: 'req-123',
    identity: { orgId, userId },
    log: jest.fn(),
  };
}

describe('withRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls the handler with correct RouteContext', async () => {
    const ctx = mockContext('org-1', 'user-1');
    (getContext as jest.Mock).mockReturnValue(ctx);

    const handler = jest.fn().mockResolvedValue(undefined);
    const middleware = withRoute(handler);

    const req = mockReq();
    const res = mockRes();

    await middleware(req, res, jest.fn());

    expect(handler).toHaveBeenCalledTimes(1);
    const routeCtx = handler.mock.calls[0][0];
    expect(routeCtx.req).toBe(req);
    expect(routeCtx.res).toBe(res);
    expect(routeCtx.ctx).toBe(ctx);
    expect(routeCtx.orgId).toBe('org-1');
    expect(routeCtx.userId).toBe('user-1');
  });

  it('lowercases orgId from context', async () => {
    const ctx = mockContext('ORG-UPPER', 'user-1');
    (getContext as jest.Mock).mockReturnValue(ctx);

    const handler = jest.fn().mockResolvedValue(undefined);
    const middleware = withRoute(handler);

    await middleware(mockReq(), mockRes(), jest.fn());

    const routeCtx = handler.mock.calls[0][0];
    expect(routeCtx.orgId).toBe('org-upper');
  });

  it('defaults userId to empty string when missing', async () => {
    const ctx = mockContext('org-1', undefined);
    (getContext as jest.Mock).mockReturnValue(ctx);

    const handler = jest.fn().mockResolvedValue(undefined);
    const middleware = withRoute(handler);

    await middleware(mockReq(), mockRes(), jest.fn());

    const routeCtx = handler.mock.calls[0][0];
    expect(routeCtx.userId).toBe('');
  });

  describe('orgId validation', () => {
    it('returns 400 when orgId is missing and requireOrgId is true (default)', async () => {
      const ctx = mockContext(undefined, 'user-1');
      (getContext as jest.Mock).mockReturnValue(ctx);

      const handler = jest.fn();
      const middleware = withRoute(handler);

      const res = mockRes();
      await middleware(mockReq(), res, jest.fn());

      expect(handler).not.toHaveBeenCalled();
      expect(sendBadRequest).toHaveBeenCalledWith(
        res,
        'Organization ID is required',
      );
    });

    it('returns 400 when orgId is empty string and requireOrgId is true', async () => {
      const ctx = mockContext('', 'user-1');
      (getContext as jest.Mock).mockReturnValue(ctx);

      const handler = jest.fn();
      const middleware = withRoute(handler);

      const res = mockRes();
      await middleware(mockReq(), res, jest.fn());

      expect(handler).not.toHaveBeenCalled();
      expect(sendBadRequest).toHaveBeenCalledWith(
        res,
        'Organization ID is required',
      );
    });

    it('allows missing orgId when requireOrgId is false', async () => {
      const ctx = mockContext(undefined, 'user-1');
      (getContext as jest.Mock).mockReturnValue(ctx);

      const handler = jest.fn().mockResolvedValue(undefined);
      const middleware = withRoute(handler, { requireOrgId: false });

      await middleware(mockReq(), mockRes(), jest.fn());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(sendBadRequest).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('catches errors and returns 500', async () => {
      const ctx = mockContext('org-1', 'user-1');
      (getContext as jest.Mock).mockReturnValue(ctx);

      const handler = jest.fn().mockRejectedValue(new Error('Something broke'));
      const middleware = withRoute(handler);

      const res = mockRes();
      await middleware(mockReq(), res, jest.fn());

      expect(sendInternalError).toHaveBeenCalledWith(res, 'Something broke');
    });

    it('maps AppError to correct status code', async () => {
      const ctx = mockContext('org-1', 'user-1');
      (getContext as jest.Mock).mockReturnValue(ctx);

      const appError = new (AppError as any)(404, 'NOT_FOUND', 'Pipeline not found');
      const handler = jest.fn().mockRejectedValue(appError);
      const middleware = withRoute(handler);

      const res = mockRes();
      await middleware(mockReq(), res, jest.fn());

      expect(sendError).toHaveBeenCalledWith(res, 404, 'Pipeline not found', 'NOT_FOUND');
      expect(sendInternalError).not.toHaveBeenCalled();
    });

    it('does not send response when headers already sent', async () => {
      const ctx = mockContext('org-1', 'user-1');
      (getContext as jest.Mock).mockReturnValue(ctx);

      const handler = jest.fn().mockRejectedValue(new Error('Late error'));
      const middleware = withRoute(handler);

      const res = mockRes();
      res.headersSent = true;
      await middleware(mockReq(), res, jest.fn());

      expect(sendError).not.toHaveBeenCalled();
      expect(sendInternalError).not.toHaveBeenCalled();
    });
  });
});
