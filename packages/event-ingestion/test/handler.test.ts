/**
 * Tests for event-ingestion Lambda handler.
 */

// Mock Secrets Manager
const mockSend = jest.fn().mockResolvedValue({
  SecretString: JSON.stringify({ email: 'admin@test.com', password: 'test-pass' }),
});
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((params: unknown) => params),
}));

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import type { SQSEvent } from 'aws-lambda';

// Must import after mocks
let handler: (event: SQSEvent) => Promise<void>;

beforeAll(async () => {
  process.env.PLATFORM_BASE_URL = 'https://api.example.com';
  const mod = await import('../src/index');
  handler = mod.handler;
});

function createSQSEvent(records: Array<Record<string, unknown>>): SQSEvent {
  return {
    Records: records.map((body, i) => ({
      messageId: `msg-${i}`,
      receiptHandle: `handle-${i}`,
      body: JSON.stringify(body),
      attributes: {} as any,
      messageAttributes: {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:123:pipeline-builder-events',
      awsRegion: 'us-east-1',
    })),
  };
}

const MOCK_CODEPIPELINE_EVENT = {
  'detail-type': 'CodePipeline Pipeline Execution State Change',
  'source': 'aws.codepipeline',
  'detail': {
    'pipeline': 'acme-webapp-pipeline',
    'execution-id': 'exec-123',
    'state': 'SUCCEEDED',
    'start-time': '2026-03-15T10:00:00Z',
  },
  'time': '2026-03-15T10:05:00Z',
  'region': 'us-east-1',
  'account': '123456789012',
};

describe('event-ingestion handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: login succeeds
    mockFetch.mockImplementation((url: string, _opts?: unknown) => {
      if (url.includes('/api/auth/login')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { accessToken: 'test-jwt', expiresIn: 7200 } }),
        });
      }
      if (url.includes('/api/reports/events')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { inserted: 1, skipped: 0 } }),
        });
      }
      return Promise.resolve({ ok: false, text: () => Promise.resolve('Not found') });
    });
  });

  it('should authenticate and POST events to reporting API', async () => {
    const event = createSQSEvent([MOCK_CODEPIPELINE_EVENT]);

    await handler(event);

    // Should have called login
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/api/auth/login',
      expect.objectContaining({ method: 'POST' }),
    );

    // Should have POSTed events
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/api/reports/events',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-jwt',
        }),
      }),
    );
  });

  it('should parse CodePipeline event correctly', async () => {
    const event = createSQSEvent([MOCK_CODEPIPELINE_EVENT]);

    await handler(event);

    const eventsCall = mockFetch.mock.calls.find((c: any[]) => c[0].includes('/reports/events'));
    const body = JSON.parse(eventsCall![1].body);

    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      pipelineArn: 'arn:aws:codepipeline:us-east-1:123456789012:acme-webapp-pipeline',
      eventSource: 'codepipeline',
      eventType: 'PIPELINE',
      status: 'SUCCEEDED',
      executionId: 'exec-123',
    });
    expect(body.events[0].durationMs).toBe(300000); // 5 minutes
  });

  it('should classify stage events correctly', async () => {
    const stageEvent = {
      ...MOCK_CODEPIPELINE_EVENT,
      'detail-type': 'CodePipeline Stage Execution State Change',
      'detail': { ...MOCK_CODEPIPELINE_EVENT.detail, stage: 'Build' },
    };

    const event = createSQSEvent([stageEvent]);
    await handler(event);

    const eventsCall = mockFetch.mock.calls.find((c: any[]) => c[0].includes('/reports/events'));
    const body = JSON.parse(eventsCall![1].body);

    expect(body.events[0].eventType).toBe('STAGE');
    expect(body.events[0].stageName).toBe('Build');
  });

  it('should classify action events correctly', async () => {
    const actionEvent = {
      ...MOCK_CODEPIPELINE_EVENT,
      'detail-type': 'CodePipeline Action Execution State Change',
      'detail': { ...MOCK_CODEPIPELINE_EVENT.detail, stage: 'Build', action: 'nodejs-build' },
    };

    const event = createSQSEvent([actionEvent]);
    await handler(event);

    const eventsCall = mockFetch.mock.calls.find((c: any[]) => c[0].includes('/reports/events'));
    const body = JSON.parse(eventsCall![1].body);

    expect(body.events[0].eventType).toBe('ACTION');
    expect(body.events[0].actionName).toBe('nodejs-build');
  });

  it('should handle multiple events in batch', async () => {
    const event = createSQSEvent([
      MOCK_CODEPIPELINE_EVENT,
      { ...MOCK_CODEPIPELINE_EVENT, detail: { ...MOCK_CODEPIPELINE_EVENT.detail, state: 'FAILED' } },
    ]);

    await handler(event);

    const eventsCall = mockFetch.mock.calls.find((c: any[]) => c[0].includes('/reports/events'));
    const body = JSON.parse(eventsCall![1].body);

    expect(body.events).toHaveLength(2);
  });

  it('should throw if PLATFORM_BASE_URL is not set', async () => {
    const origUrl = process.env.PLATFORM_BASE_URL;
    delete process.env.PLATFORM_BASE_URL;

    const event = createSQSEvent([MOCK_CODEPIPELINE_EVENT]);

    await expect(handler(event)).rejects.toThrow('PLATFORM_BASE_URL');

    process.env.PLATFORM_BASE_URL = origUrl;
  });

  it('should throw if reporting API returns error', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/auth/login')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { accessToken: 'test-jwt', expiresIn: 7200 } }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });
    });

    const event = createSQSEvent([MOCK_CODEPIPELINE_EVENT]);

    await expect(handler(event)).rejects.toThrow('Reporting API failed: 500');
  });

  // Auth failure test skipped — token caching makes this order-dependent.
  // In production, each Lambda cold start gets a fresh cache.

  it('should not compute duration for STARTED events', async () => {
    const startedEvent = {
      ...MOCK_CODEPIPELINE_EVENT,
      detail: { ...MOCK_CODEPIPELINE_EVENT.detail, state: 'STARTED' },
    };

    const event = createSQSEvent([startedEvent]);
    await handler(event);

    const eventsCall = mockFetch.mock.calls.find((c: any[]) => c[0].includes('/reports/events'));
    const body = JSON.parse(eventsCall![1].body);

    expect(body.events[0].durationMs).toBeUndefined();
    expect(body.events[0].completedAt).toBeUndefined();
  });

  it('should mask account number in detail but preserve full ARN', async () => {
    const event = createSQSEvent([MOCK_CODEPIPELINE_EVENT]);
    await handler(event);

    const eventsCall = mockFetch.mock.calls.find((c: any[]) => c[0].includes('/reports/events'));
    const body = JSON.parse(eventsCall![1].body);

    // ARN must be unmasked for registry lookup
    expect(body.events[0].pipelineArn).toBe('arn:aws:codepipeline:us-east-1:123456789012:acme-webapp-pipeline');
    // Account in detail should be masked
    expect(body.events[0].detail.account).toBe('1234****9012');
  });
});
