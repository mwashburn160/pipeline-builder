// Mock api-core before imports
jest.mock('@mwashburn160/api-core', () => ({
  ErrorCode: { VALIDATION_ERROR: 'VALIDATION_ERROR' },
  sendError: jest.fn(),
}));

// Mock get-context to control behavior
jest.mock('../src/api/get-context', () => ({
  getContext: jest.fn(),
}));

import { sendError } from '@mwashburn160/api-core';
import { getContext } from '../src/api/get-context';
import { requireOrgId } from '../src/api/require-org-id';

function mockReq(): any {
  return { headers: {} };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('requireOrgId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls next() when orgId is present', () => {
    const mockCtx = {
      identity: { orgId: 'org-1' },
      log: jest.fn(),
    };
    (getContext as jest.Mock).mockReturnValue(mockCtx);

    const middleware = requireOrgId();
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
  });

  it('returns 400 when orgId is missing', () => {
    const mockCtx = {
      identity: { orgId: undefined },
      log: jest.fn(),
    };
    (getContext as jest.Mock).mockReturnValue(mockCtx);

    const middleware = requireOrgId();
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockCtx.log).toHaveBeenCalledWith('ERROR', expect.stringContaining('Organization ID is missing'));
    expect(sendError).toHaveBeenCalledWith(
      res,
      400,
      expect.stringContaining('Organization ID is required'),
      'VALIDATION_ERROR',
    );
  });

  it('returns 400 when orgId is empty string', () => {
    const mockCtx = {
      identity: { orgId: '' },
      log: jest.fn(),
    };
    (getContext as jest.Mock).mockReturnValue(mockCtx);

    const middleware = requireOrgId();
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(
      res,
      400,
      expect.stringContaining('Organization ID is required'),
      'VALIDATION_ERROR',
    );
  });

  it('throws when context middleware is not applied', () => {
    (getContext as jest.Mock).mockImplementation(() => {
      throw new Error('Request context not initialized. Ensure attachRequestContext middleware is applied.');
    });

    const middleware = requireOrgId();
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    expect(() => middleware(req, res, next)).toThrow(
      'Request context not initialized',
    );
    expect(next).not.toHaveBeenCalled();
  });
});
