// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

// Set PLATFORM_SECRET_NAME before import — module-level check throws if missing
process.env.PLATFORM_SECRET_NAME = 'pipeline-builder/test-org/platform';

// Keep the retry backoff fast: the handler reads its constants from the
// dependency-free leaf module.
jest.unstable_mockModule('../src/config/handler-constants.js', () => ({
  DEFAULT_PLATFORM_URL: 'https://localhost:8443',
  HANDLER_TIMEOUT_MS: 25000,
  HANDLER_DEFAULT_BASE_URL: 'https://default.example.com',
  HANDLER_MAX_RETRIES: 2,
  HANDLER_RETRY_DELAY_MS: 1,
  HANDLER_RETRY_AFTER_MAX_MS: 10_000,
}));

const STORED_KEY = 'pb_sa_1111111111111111111111111111aaaa';
const ROTATED_KEY = 'pb_sa_2222222222222222222222222222bbbb';

// Mock Secrets Manager — schema is { username, password, ... } where
// `password` carries the service-account key (same field CodeBuild's
// secretsManagerCredentials reads as Basic auth).
const mockSend = jest.fn<AnyFn>().mockResolvedValue({
  SecretString: JSON.stringify({ username: 'test-org', password: STORED_KEY }),
});
jest.unstable_mockModule('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((params: unknown) => params),
}));

// Mock axios before importing handler
const mockPost = jest.fn<AnyFn>();
const mockAxiosCreate = jest.fn((..._args: unknown[]) => ({ post: mockPost }));

class AxiosError extends Error {
  code?: string;
  response?: { status: number; statusText: string; data?: unknown; headers?: Record<string, string> };
  constructor(message: string, code?: string, _config?: unknown, _request?: unknown, response?: { status: number; statusText: string; data?: unknown; headers?: Record<string, string> }) {
    super(message);
    this.name = 'AxiosError';
    this.code = code;
    this.response = response;
  }
}

jest.unstable_mockModule('axios', () => ({
  __esModule: true,
  default: { create: mockAxiosCreate },
  AxiosError,
}));

const { handler, _resetCredentialsCache } = await import('../src/handlers/plugin-lookup-handler.js');
const { unwrapLookup, summarizeLookupWarnings } = await import('../src/core/plugin-lookup-envelope.js');
const { describeRefusal, retryAfterMs, truncateReason } = await import('../src/handlers/plugin-lookup-handler.js');


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
    _resetCredentialsCache();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    process.env = { ...originalEnv };
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({ username: 'test-org', password: STORED_KEY }),
    });
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

    it('should pass Authorization header with token from Secrets Manager', async () => {
      mockPost.mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent();
      await handler(event);

      expect(mockAxiosCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${STORED_KEY}`,
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

  describe('logging (account-id leak prevention)', () => {
    it('should not log the StackId ARN (embeds AWS account id) in the START log', async () => {
      mockPost.mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const logSpy = jest.spyOn(console, 'log');
      // StackId ARN carries a 12-digit AWS account id (…:cloudformation:us-east-1:123456789012:stack/…)
      const event = createEvent({
        StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/my-stack/abc-guid',
      });
      await handler(event);

      // Reconstruct everything the handler wrote to CloudWatch (console.log).
      const logged = logSpy.mock.calls
        .map((call) => call.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
        .join('\n');

      // No ARN, no account-id segment, and no stackId key should ever be persisted.
      expect(logged).not.toContain('arn:aws');
      expect(logged).not.toContain('123456789012');
      expect(logged).not.toMatch(/stackId/i);

      // Correlation identifiers are still present.
      expect(logged).toContain('req-123');
      expect(logged).toContain('PluginLookup');
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
    it('should fetch token from Secrets Manager', async () => {
      mockPost.mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const event = createEvent();
      await handler(event);

      expect(mockSend).toHaveBeenCalled();
    });

    it('should fail if Secrets Manager returns empty secret', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: undefined });

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('empty');
    });

    it('should fail if secret is missing password field', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ someOtherField: 'no-token-here' }) });

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('missing password');
    });

    it('refuses a stored JWT instead of presenting it', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ password: 'aaa.bbb.ccc' }) });

      const result = await handler(createEvent());

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('holds a JWT');
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('caches the key across warm invocations', async () => {
      mockPost.mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 }).mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });
      await handler(createEvent());
      await handler(createEvent());
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403])('on %i re-reads the rotated key from the secret and retries once', async (status) => {
      // Warm container: the cached key was rotated + revoked by token-renew.
      mockPost.mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });
      await handler(createEvent());
      mockSend.mockResolvedValue({ SecretString: JSON.stringify({ password: ROTATED_KEY }) });
      mockPost
        .mockRejectedValueOnce(new AxiosError('refused', String(status), undefined, undefined, { status, statusText: 'Unauthorized' }))
        .mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });

      const result = await handler(createEvent());

      expect(result.Status).toBe('SUCCESS');
      expect(mockSend).toHaveBeenCalledTimes(2);
      const lastCreate = mockAxiosCreate.mock.calls.at(-1)?.[0] as { headers: Record<string, string> };
      expect(lastCreate.headers.Authorization).toBe(`Bearer ${ROTATED_KEY}`);
    });

    it('fails when the lookup answers with no plugin', async () => {
      mockPost.mockResolvedValueOnce({ data: {}, status: 200 });

      const result = await handler(createEvent());

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('Empty response data');
    });

    it('fails after a second refusal without looping', async () => {
      const refused = () => new AxiosError('refused', '401', undefined, undefined, { status: 401, statusText: 'Unauthorized' });
      mockPost.mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused());

      const result = await handler(createEvent());

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('401');
      expect(mockPost).toHaveBeenCalledTimes(2);
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
      expect(result.Reason).toContain('400');
    });

    it('should return FAILED on timeout', async () => {
      const axiosErr = new AxiosError('timeout', 'ECONNABORTED');
      mockPost.mockRejectedValueOnce(axiosErr);

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('timed out');
    });

    it('should return FAILED on network error', async () => {
      const axiosErr = new AxiosError('connect failed', 'ECONNREFUSED');
      mockPost.mockRejectedValueOnce(axiosErr);

      const event = createEvent();
      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
    });

    it('fails FAST on a quota refusal — no retry — with the quota, numbers, reset date and upgrade link', async () => {
      mockPost.mockRejectedValueOnce(new AxiosError('Request failed', '429', undefined, undefined, {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '86400' },
        data: {
          code: 'QUOTA_EXCEEDED',
          message: 'Automation call quota exceeded',
          details: { quotaType: 'automationCalls', limit: 50000, used: 50000, resetAt: '2026-11-05T00:00:00.000Z', upgradeUrl: '/dashboard/billing' },
        },
      }));
      const result = await handler(createEvent());
      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('Automation call quota reached (50,000/50,000); resets 2026-11-05. Upgrade: https://api.example.com/dashboard/billing');
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('retries a plain 429 (a rate limit, not a quota)', async () => {
      mockPost
        .mockRejectedValueOnce(new AxiosError('Request failed', '429', undefined, undefined, { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '0' } }))
        .mockResolvedValueOnce({ data: MOCK_PLUGIN, status: 200 });
      const result = await handler(createEvent());
      expect(result.Status).toBe('SUCCESS');
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it('reads Retry-After as delta-seconds, clipped to what the invocation can afford', () => {
      expect(retryAfterMs({ 'retry-after': '3' })).toBe(3000);
      expect(retryAfterMs({ 'retry-after': '3600' })).toBe(10_000);
      expect(retryAfterMs({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })).toBeUndefined();
      expect(retryAfterMs(undefined)).toBeUndefined();
    });

    it('puts the service\'s code, message and details into the CloudFormation Reason', async () => {
      // A 403 also reads as a possibly-rotated credential: re-read + retry once, then report.
      const refusal = () => new AxiosError('Request failed', '403', undefined, undefined, {
        status: 403,
        statusText: 'Forbidden',
        data: { code: 'PLUGIN_BLOCKED_BY_POLICY', message: 'denied by org policy', details: { rule: 'deny:acme/*' }, stack: 'NEVER-ECHOED' },
      });
      mockPost.mockRejectedValueOnce(refusal()).mockRejectedValueOnce(refusal());
      const result = await handler(createEvent());
      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('PLUGIN_BLOCKED_BY_POLICY: denied by org policy');
      expect(result.Reason).toContain('"rule":"deny:acme/*"');
      expect(result.Reason).not.toContain('NEVER-ECHOED');
      expect(result.Reason).not.toContain('403: Forbidden');
    });

    it.each([
      ['deleted', 'was deleted from your organization'],
      ['inactive', 'is inactive'],
      ['yanked', 'was yanked'],
      [undefined, 'does not exist (never published'],
    ])('phrases an exact pin 404 from details.state=%s', async (state, text) => {
      mockPost.mockRejectedValueOnce(new AxiosError('nf', '404', undefined, undefined, {
        status: 404,
        statusText: 'Not Found',
        data: { code: 'NOT_FOUND', message: 'Plugin not found', ...(state ? { details: { state } } : {}) },
      }));
      const result = await handler(createEvent({
        ResourceProperties: { ServiceToken: 'x', baseURL: 'https://api.example.com', pluginFilter: { name: 'trivy', version: '1.2.0' } },
      } as never));
      expect(result.Reason).toContain(`"trivy" version 1.2.0 ${text}`);
    });

    it('sends the lookup context when the pipeline id and step key are known', async () => {
      process.env.PIPELINE_ID = 'pipe-1';
      mockPost.mockResolvedValueOnce({ data: { data: { plugin: MOCK_PLUGIN } }, status: 200 });
      await handler(createEvent({
        ResourceProperties: { ServiceToken: 'x', baseURL: 'https://api.example.com', pluginFilter: { name: 'nodejs-build' }, stepKey: 'Build/build' },
      } as never));
      expect(mockPost.mock.calls[0]![1]).toEqual({ filter: { name: 'nodejs-build' }, context: { pipelineId: 'pipe-1', stepKeys: ['Build/build'] } });
    });

    it('sends the Lambda awsRequestId as X-Request-Id', async () => {
      mockPost.mockResolvedValueOnce({ data: { data: { plugin: MOCK_PLUGIN } }, status: 200 });
      await handler(createEvent(), { awsRequestId: 'req-1234\r\nX-Evil: 1' });
      const opts = mockAxiosCreate.mock.calls[0]![0] as { headers: Record<string, string> };
      // CR/LF and spaces are stripped — no header injection through the id.
      expect(opts.headers['X-Request-Id']).toBe('req-1234X-Evil:1');
    });

    it('sends no X-Request-Id without a Lambda context', async () => {
      mockPost.mockResolvedValueOnce({ data: { data: { plugin: MOCK_PLUGIN } }, status: 200 });
      await handler(createEvent());
      const opts = mockAxiosCreate.mock.calls[0]![0] as { headers: Record<string, string> };
      expect(opts.headers['X-Request-Id']).toBeUndefined();
    });

    it('omits the lookup context without a pipeline id', async () => {
      delete process.env.PIPELINE_ID;
      mockPost.mockResolvedValueOnce({ data: { data: { plugin: MOCK_PLUGIN } }, status: 200 });
      await handler(createEvent());
      expect(mockPost.mock.calls[0]![1]).toEqual({ filter: { name: 'nodejs-build', isActive: true } });
    });

    it('verifies against PLATFORM_CA_BUNDLE when set (never disables verification)', async () => {
      process.env.PLATFORM_CA_BUNDLE = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
      mockPost.mockResolvedValueOnce({ data: { data: { plugin: MOCK_PLUGIN } }, status: 200 });
      await handler(createEvent());
      const opts = mockAxiosCreate.mock.calls[0]![0] as { httpsAgent?: { options: { ca?: string[]; rejectUnauthorized?: boolean } } };
      expect(opts.httpsAgent?.options.ca?.at(-1)).toContain('MIIB');
      expect(opts.httpsAgent?.options.rejectUnauthorized).not.toBe(false);
    });

    it('should return FAILED on invalid baseURL', async () => {
      const event = createEvent({
        ResourceProperties: {
          ServiceToken: 'arn:aws:lambda:us-east-1:123456789:function:test',
          baseURL: 'ftp://invalid',
          pluginFilter: { name: 'test' },
        },
      });

      const result = await handler(event);

      expect(result.Status).toBe('FAILED');
      expect(result.Reason).toContain('Invalid baseURL');
    });
  });
});

describe('unwrapLookup — the /plugins/lookup envelope', () => {
  it('returns the managed toolchain release when the answer carries one', () => {
    const res = unwrapLookup({
      data: {
        plugin: { ...MOCK_PLUGIN, toolchain: { awsCdk: '2.1.0', node: '26.0.0' } },
        warnings: [],
        toolchain: { releaseVersion: '1.2.0', resolvedVia: 'pin', versions: { cdkAssets: '4.0.0' } },
      },
    });
    expect(res.toolchain).toEqual({ releaseVersion: '1.2.0', resolvedVia: 'pin', versions: { awsCdk: '2.1.0', node: '26.0.0', cdkAssets: '4.0.0' } });
  });

  it('reads the tool versions the platform persists on the bootstrap row\'s metadata', () => {
    const res = unwrapLookup({
      data: {
        plugin: { ...MOCK_PLUGIN, metadata: { 'toolchain.awsCdk': '2.1148.0', 'toolchain.cdkAssets': '4.8.0', 'other': 'x' } },
        toolchain: { releaseVersion: '1.1.0', resolvedVia: 'default' },
      },
    });
    expect(res.toolchain?.versions).toEqual({ awsCdk: '2.1148.0', cdkAssets: '4.8.0' });
  });

  it('omits toolchain for an ordinary plugin and for a malformed block', () => {
    expect(unwrapLookup({ data: { plugin: MOCK_PLUGIN, warnings: [] } })).not.toHaveProperty('toolchain');
    expect(unwrapLookup({ data: { plugin: MOCK_PLUGIN, toolchain: { releaseVersion: '1.2.0', resolvedVia: 'highest' } } })).not.toHaveProperty('toolchain');
    expect(unwrapLookup({ data: { plugin: MOCK_PLUGIN, toolchain: { resolvedVia: 'default' } } })).not.toHaveProperty('toolchain');
  });

  it('unwraps { data: { plugin, warnings } } and keeps the graded warnings', () => {
    expect(unwrapLookup({
      success: true,
      data: {
        plugin: MOCK_PLUGIN,
        warnings: [
          { code: 'PLUGIN_DEPRECATED', message: 'deprecated' },
          { code: 'VULN_FLAGGED', message: 'kev', severity: 'critical' },
          { code: 'X' },
        ],
      },
    }))
      .toEqual({
        plugin: MOCK_PLUGIN,
        warnings: [
          { code: 'PLUGIN_DEPRECATED', message: 'deprecated', severity: 'warning' },
          { code: 'VULN_FLAGGED', message: 'kev', severity: 'critical' },
        ],
      });
  });

  it('defaults an unknown severity to warning', () => {
    expect(unwrapLookup({ data: { plugin: MOCK_PLUGIN, warnings: [{ message: 'm', severity: 'apocalyptic' }] } }).warnings)
      .toEqual([{ message: 'm', severity: 'warning' }]);
  });

  it('summarizes graded warnings most-serious first', () => {
    expect(summarizeLookupWarnings([])).toBeNull();
    expect(summarizeLookupWarnings([{ severity: 'error' }, { severity: 'critical' }, { severity: 'error' }]))
      .toBe('3 plugin warnings: 1 critical, 2 error');
    expect(summarizeLookupWarnings([{ severity: 'info' }])).toBe('1 plugin warning: 1 info');
  });

  it('tolerates { plugin } and a bare plugin', () => {
    expect(unwrapLookup({ plugin: MOCK_PLUGIN }).plugin).toEqual(MOCK_PLUGIN);
    expect(unwrapLookup(MOCK_PLUGIN)).toEqual({ plugin: MOCK_PLUGIN, warnings: [] });
  });

  it('yields no plugin for an empty or nameless answer', () => {
    expect(unwrapLookup(null)).toEqual({ plugin: null, warnings: [] });
    expect(unwrapLookup({ data: { plugin: null } }).plugin).toBeNull();
  });

  it('drops warnings that are not { message } objects', () => {
    expect(unwrapLookup({ data: { plugin: MOCK_PLUGIN, warnings: ['bare', null, { message: '' }] } }).warnings).toEqual([]);
  });

  it('logs lifecycle warnings at deploy time and still succeeds', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPost.mockResolvedValueOnce({ data: { success: true, data: { plugin: MOCK_PLUGIN, warnings: [{ code: 'PLUGIN_YANKED', message: 'yanked but pinned' }] } }, status: 200 });
    const result = await handler(createEvent());
    expect(result.Status).toBe('SUCCESS');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('yanked but pinned');
    warn.mockRestore();
  });
});


describe('CloudFormation reason helpers', () => {
  it('truncates to the byte cap on a character boundary', () => {
    const long = 'é'.repeat(4000);
    const out = truncateReason(long, 100);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(100);
    expect(out.endsWith('…[truncated]')).toBe(true);
    expect(truncateReason('short', 100)).toBe('short');
  });

  it('falls back to the HTTP status when the body carries no message', () => {
    expect(describeRefusal(502, 'Bad Gateway', undefined)).toBe('API error 502: Bad Gateway');
  });
});
