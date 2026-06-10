// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock dependencies
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: jest.fn(),
}));

const { notFoundHandler, errorHandler } = await import('../src/middleware/error.js');

const { sendError } = await import('@pipeline-builder/api-core');

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
