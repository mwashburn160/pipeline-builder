// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------
jest.mock('@mwashburn160/api-core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  sendError: jest.fn(),
  ErrorCode: {
    NOT_FOUND: 'NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
  },
}));

import { sendError } from '@mwashburn160/api-core';
import { notFoundHandler, errorHandler } from '../src/middleware/error.middleware';

const mockSendError = sendError as jest.MockedFunction<typeof sendError>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockReq(overrides: Partial<{ method: string; originalUrl: string }> = {}) {
  return {
    method: overrides.method || 'GET',
    originalUrl: overrides.originalUrl || '/unknown',
  } as any;
}

function mockRes() {
  return {} as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('error middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('notFoundHandler', () => {
    it('should send 404 response', () => {
      const res = mockRes();
      notFoundHandler(mockReq(), res);

      expect(mockSendError).toHaveBeenCalledWith(
        res, 404,
        expect.stringContaining('not be found'),
        'NOT_FOUND',
      );
    });
  });

  describe('errorHandler', () => {
    it('should use error status when provided', () => {
      const err = Object.assign(new Error('Forbidden'), { status: 403 }) as Error & { status: number };
      const res = mockRes();

      errorHandler(err, mockReq(), res, jest.fn());

      expect(mockSendError).toHaveBeenCalledWith(res, 403, 'Forbidden', 'INTERNAL_ERROR');
    });

    it('should default to 500 when no status', () => {
      const err = new Error('Unexpected') as Error & { status?: number };
      const res = mockRes();

      errorHandler(err, mockReq(), res, jest.fn());

      expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Unexpected', 'INTERNAL_ERROR');
    });
  });
});
