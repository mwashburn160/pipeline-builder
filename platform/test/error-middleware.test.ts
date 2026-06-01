// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock dependencies
jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  sendError: jest.fn(),
  // Subset of api-core's ErrorCode enum used by middleware/error.ts.
  // `pickClientErrorCode` maps 4xx → code; INTERNAL_ERROR is reserved for 5xx.
  ErrorCode: {
    NOT_FOUND: 'NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    UNAUTHORIZED: 'UNAUTHORIZED',
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
    CONFLICT: 'CONFLICT',
    PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
    RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  },
}));

import { sendError } from '@pipeline-builder/api-core';
import { notFoundHandler, errorHandler } from '../src/middleware/error';

const mockSendError = sendError as jest.MockedFunction<typeof sendError>;

// Helpers
function mockReq(overrides: Partial<{ method: string; originalUrl: string }> = {}) {
  return {
    method: overrides.method || 'GET',
    originalUrl: overrides.originalUrl || '/unknown',
  } as any;
}

function mockRes() {
  return {} as any;
}

// Tests

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

      // 4xx now picks a status-specific ErrorCode via pickClientErrorCode
      // (403 → INSUFFICIENT_PERMISSIONS) rather than always INTERNAL_ERROR.
      expect(mockSendError).toHaveBeenCalledWith(res, 403, 'Forbidden', 'INSUFFICIENT_PERMISSIONS');
    });

    it('should default to 500 when no status', () => {
      const err = new Error('Unexpected') as Error & { status?: number };
      const res = mockRes();

      errorHandler(err, mockReq(), res, jest.fn());

      // 5xx now substitutes a generic message to avoid leaking err.message
      // (could contain stack/secret fragments); status + INTERNAL_ERROR stay.
      expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    });
  });
});
