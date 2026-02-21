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
}));

import { ServiceError, BaseServiceClient } from '../src/services/base-service';

// ---------------------------------------------------------------------------
// Concrete implementation for testing
// ---------------------------------------------------------------------------
class TestServiceClient extends BaseServiceClient {
  protected serviceName = 'TestService';

  protected createError(message: string, statusCode: number, code?: string): ServiceError {
    return new ServiceError(message, statusCode, code);
  }

  // Expose protected methods for testing
  public testBuildQueryString(filter: object): string {
    return this.buildQueryString(filter);
  }

  public async testRequest<T>(url: string, options: any): Promise<T> {
    return this.request<T>(url, options);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ServiceError', () => {
  it('should create error with message, statusCode, and code', () => {
    const err = new ServiceError('Not found', 404, 'NOT_FOUND');

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Not found');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.name).toBe('ServiceError');
  });

  it('should work without code', () => {
    const err = new ServiceError('Server error', 500);
    expect(err.code).toBeUndefined();
  });
});

describe('BaseServiceClient', () => {
  let client: TestServiceClient;

  beforeEach(() => {
    client = new TestServiceClient(5000);
  });

  describe('buildQueryString', () => {
    it('should build query string from object', () => {
      const qs = client.testBuildQueryString({ name: 'test', version: '1.0' });
      expect(qs).toBe('?name=test&version=1.0');
    });

    it('should skip undefined/null/empty values', () => {
      const qs = client.testBuildQueryString({
        name: 'test',
        version: undefined,
        tag: null,
        empty: '',
        active: true,
      });
      expect(qs).toBe('?name=test&active=true');
    });

    it('should return empty string when all values are empty', () => {
      const qs = client.testBuildQueryString({});
      expect(qs).toBe('');
    });

    it('should convert numbers to strings', () => {
      const qs = client.testBuildQueryString({ page: 1, limit: 20 });
      expect(qs).toBe('?page=1&limit=20');
    });

    it('should convert booleans to strings', () => {
      const qs = client.testBuildQueryString({ isActive: true, isDefault: false });
      expect(qs).toBe('?isActive=true&isDefault=false');
    });
  });

  describe('request', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should throw when token is missing', async () => {
      await expect(
        client.testRequest('http://test.com/api', {
          orgId: 'org-1',
          token: '',
        }),
      ).rejects.toThrow('Authentication token is required');
    });

    it('should make fetch call with correct headers', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { id: '1' } }),
      });
      global.fetch = mockFetch;

      await client.testRequest('http://svc/api', {
        orgId: 'org-1',
        userId: 'user-1',
        token: 'my-token',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://svc/api',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-org-id': 'org-1',
            'x-user-id': 'user-1',
            'Authorization': 'Bearer my-token',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('should return data on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [1, 2, 3] }),
      });

      const result = await client.testRequest('http://svc/api', {
        orgId: 'org-1',
        token: 'tok',
      });

      expect(result).toEqual({ success: true, data: [1, 2, 3] });
    });

    it('should throw ServiceError on non-ok response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ message: 'Not found', code: 'NOT_FOUND' }),
      });

      await expect(
        client.testRequest('http://svc/api', { orgId: 'org-1', token: 'tok' }),
      ).rejects.toMatchObject({
        message: 'Not found',
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('should throw timeout error on abort', async () => {
      global.fetch = jest.fn().mockRejectedValue(
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      );

      await expect(
        client.testRequest('http://svc/api', { orgId: 'org-1', token: 'tok' }),
      ).rejects.toMatchObject({
        message: 'Request timeout',
        statusCode: 504,
        code: 'TIMEOUT',
      });
    });

    it('should wrap generic errors as 500', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      await expect(
        client.testRequest('http://svc/api', { orgId: 'org-1', token: 'tok' }),
      ).rejects.toMatchObject({
        message: 'Connection refused',
        statusCode: 500,
        code: 'SERVICE_ERROR',
      });
    });

    it('should handle non-Error throws', async () => {
      global.fetch = jest.fn().mockRejectedValue('string error');

      await expect(
        client.testRequest('http://svc/api', { orgId: 'org-1', token: 'tok' }),
      ).rejects.toMatchObject({
        message: 'Unknown error',
        statusCode: 500,
        code: 'UNKNOWN_ERROR',
      });
    });
  });
});
