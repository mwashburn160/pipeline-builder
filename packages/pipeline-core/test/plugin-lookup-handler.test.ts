import { CloudFormationCustomResourceEvent } from 'aws-lambda';

// Mock CoreConstants BEFORE importing handler — these are module-level constants
// that freeze at import time, so process.env overrides in beforeEach have no effect.
jest.mock('../src/config/app-config', () => ({
  CoreConstants: {
    HANDLER_TIMEOUT_MS: 25000,
    HANDLER_DEFAULT_BASE_URL: 'https://default.example.com',
    HANDLER_MAX_RETRIES: 2,
    HANDLER_RETRY_DELAY_MS: 1, // 1ms instead of 1000ms to keep tests fast
  },
}));

// Mock axios before importing handler
const mockPost = jest.fn();
const mockAxiosCreate = jest.fn(() => ({ post: mockPost }));
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: mockAxiosCreate },
  AxiosError: class AxiosError extends Error {
    code?: string;
    response?: { status: number; statusText: string; data?: unknown };
    constructor(message: string, code?: string, _config?: unknown, _request?: unknown, response?: { status: number; statusText: string; data?: unknown }) {
      super(message);
      this.name = 'AxiosError';
      this.code = code;
      this.response = response;
    }
  },
}));

import { handler } from '../src/handlers/plugin-lookup-handler';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AxiosError } = require('axios');


const MOCK_PLUGIN = {
  id: '123',
  name: 'nodejs-build',
  version: '1.0.0',
  commands: ['npm ci', 'npm run build'],
  orgId: 'org-1',
  createdBy: 'system',
  createdAt: new Date().toISOString(),
  updatedBy: 'system',
  updatedAt: new Date().toISOString(),
};

function createEvent(overrides: Partial<CloudFormationCustomResourceEvent> = {}): CloudFormationCustomResourceEvent {
  return {
    RequestType: 'Create',
    ServiceToken: 'arn:aws:lambda:us-east-1:123456789:function:test',
    ResponseURL: 'https://cloudformation.example.com',
    StackId: 'arn:aws:cloudformation:us-east-1:123456789:stack/test/guid',
    RequestId: 'req-123',
    ResourceType: 'Custom::PluginLookup',
    LogicalResourceId: 'PluginLookup',
    ResourceProperties: {
      ServiceToken: 'arn:aws:lambda:us-east-1:123456789:function:test',
      baseURL: 'https://api.example.com',
      pluginFilter: { name: 'nodejs-build', isActive: true },
    },
    ...overrides,
  } as CloudFormationCustomResourceEvent;
}

describe('plugin-lookup-handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'debug').mockImplementation();
    process.env = { ...originalEnv, PLATFORM_TOKEN: 'test-token' };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('Delete requests', () => {
    it('should return SUCCESS for Delete requests (no-op)', async () => {
      const event = createEvent({ RequestType: 'Delete' });
      const result = await handler(event);

      expect(result.Status).toBe('SUCCESS');
      expect(result.Reason).toBe('Delete completed (no-op)');
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe('Create/Update requests', () => {
    it('should fetch plugin and return base64-encoded result on success', async () => {
      mockPost.mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('SUCCESS');
      expect(result.Data?.ResultValue).toBeDefined();

      const decoded = JSON.parse(Buffer.from(result.Data!.ResultValue as string, 'base64').toString('utf-8'));
      expect(decoded.name).toBe('nodejs-build');
      expect(decoded.version).toBe('1.0.0');
    });

    it('should use baseURL from resource properties', async () => {
      mockPost.mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent();
      await handler(event);

      expect(mockAxiosCreate).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'https://api.example.com' }),
      );
    });

    it('should pass Authorization header with PLATFORM_TOKEN', async () => {
      mockPost.mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent();
      await handler(event);

      expect(mockAxiosCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
    });

    it('should post to /api/plugins/lookup with filter', async () => {
      mockPost.mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const filter = { name: 'nodejs-build', isActive: true };
      const event = createEvent({
        ResourceProperties: {
          ServiceToken: 'arn:aws:lambda:us-east-1:123456789:function:test',
          baseURL: 'https://api.example.com',
          pluginFilter: filter,
        },
      });

      await handler(event);

      expect(mockPost).toHaveBeenCalledWith('/api/plugins/lookup', { filter });
    });

    it('should include StackId, RequestId, LogicalResourceId in response', async () => {
      mockPost.mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent();
      const result = await handler(event);

      expect(result.StackId).toBe(event.StackId);
      expect(result.RequestId).toBe(event.RequestId);
      expect(result.LogicalResourceId).toBe(event.LogicalResourceId);
      expect(result.PhysicalResourceId).toBe(event.LogicalResourceId);
    });

    it('should work with Update request type', async () => {
      mockPost.mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent({ RequestType: 'Update' });
      const result = await handler(event);

      expect(result.Status).toBe('SUCCESS');
    });
  });

  describe('validation', () => {
    it('should fail if pluginFilter is missing', async () => {
      const event = createEvent({
        ResourceProperties: {
          ServiceToken: 'arn:aws:lambda:us-east-1:123456789:function:test',
          baseURL: 'https://api.example.com',
          pluginFilter: undefined as unknown,
        },
      } as Partial<CloudFormationCustomResourceEvent>);

      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('Missing or invalid pluginFilter');
    });

    it('should fail if pluginFilter has no criteria', async () => {
      const event = createEvent({
        ResourceProperties: {
          ServiceToken: 'arn:aws:lambda:us-east-1:123456789:function:test',
          baseURL: 'https://api.example.com',
          pluginFilter: {},
        },
      });

      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('at least one criterion');
    });
  });

  describe('authentication', () => {
    it('should fail if PLATFORM_TOKEN is not set', async () => {
      delete process.env.PLATFORM_TOKEN;

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('PLATFORM_TOKEN environment variable is not set');
    });
  });

  describe('error handling', () => {
    it('should return FAILED on API error', async () => {
      const axiosErr = new AxiosError(
        'Request failed',
        '400',
        undefined,
        undefined,
        { status: 400, statusText: 'Bad Request' },
      );
      mockPost.mockRejectedValueOnce(axiosErr);

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('API error 400');
    });

    it('should return FAILED on timeout', async () => {
      const axiosErr = new AxiosError('timeout', 'ECONNABORTED');
      mockPost.mockRejectedValueOnce(axiosErr);

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('timed out');
    });

    it('should return FAILED on empty response data', async () => {
      mockPost.mockResolvedValueOnce({ data: null, status: 200 });

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('Empty response data');
    });
  });

  describe('retry logic', () => {
    it('should retry on 503 and succeed on second attempt', async () => {
      const axiosErr = new AxiosError(
        'Service Unavailable',
        '503',
        undefined,
        undefined,
        { status: 503, statusText: 'Service Unavailable' },
      );
      mockPost
        .mockRejectedValueOnce(axiosErr)
        .mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('SUCCESS');
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it('should retry on 429 (rate limited)', async () => {
      const axiosErr = new AxiosError(
        'Too Many Requests',
        '429',
        undefined,
        undefined,
        { status: 429, statusText: 'Too Many Requests' },
      );
      mockPost
        .mockRejectedValueOnce(axiosErr)
        .mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('SUCCESS');
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it('should retry on 502 (bad gateway)', async () => {
      const axiosErr = new AxiosError(
        'Bad Gateway',
        '502',
        undefined,
        undefined,
        { status: 502, statusText: 'Bad Gateway' },
      );
      mockPost
        .mockRejectedValueOnce(axiosErr)
        .mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('SUCCESS');
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it('should retry on 504 (gateway timeout)', async () => {
      const axiosErr = new AxiosError(
        'Gateway Timeout',
        '504',
        undefined,
        undefined,
        { status: 504, statusText: 'Gateway Timeout' },
      );
      mockPost
        .mockRejectedValueOnce(axiosErr)
        .mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('SUCCESS');
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it('should retry on ECONNRESET', async () => {
      const axiosErr = new AxiosError('Connection reset', 'ECONNRESET');
      mockPost
        .mockRejectedValueOnce(axiosErr)
        .mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('SUCCESS');
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it('should NOT retry on 400 (client error)', async () => {
      const axiosErr = new AxiosError(
        'Bad Request',
        '400',
        undefined,
        undefined,
        { status: 400, statusText: 'Bad Request' },
      );
      mockPost.mockRejectedValueOnce(axiosErr);

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry on 401 (unauthorized)', async () => {
      const axiosErr = new AxiosError(
        'Unauthorized',
        '401',
        undefined,
        undefined,
        { status: 401, statusText: 'Unauthorized' },
      );
      mockPost.mockRejectedValueOnce(axiosErr);

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry on timeout (ECONNABORTED)', async () => {
      const axiosErr = new AxiosError('timeout', 'ECONNABORTED');
      mockPost.mockRejectedValueOnce(axiosErr);

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('should fail after exhausting all retries', async () => {
      const axiosErr = new AxiosError(
        'Service Unavailable',
        '503',
        undefined,
        undefined,
        { status: 503, statusText: 'Service Unavailable' },
      );
      mockPost
        .mockRejectedValueOnce(axiosErr)
        .mockRejectedValueOnce(axiosErr)
        .mockRejectedValueOnce(axiosErr);

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('503');
      expect(mockPost).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  describe('fallback baseURL', () => {
    it('should use HANDLER_DEFAULT_BASE_URL when baseURL not in resource properties', async () => {
      mockPost.mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent({
        ResourceProperties: {
          ServiceToken: 'arn:aws:lambda:us-east-1:123456789:function:test',
          pluginFilter: { name: 'nodejs-build' },
        },
      });

      await handler(event);

      // Verify the mocked default URL from handler-constants is used
      expect(mockAxiosCreate).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'https://default.example.com' }),
      );
    });
  });
});
