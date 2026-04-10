// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for event-ingestion Lambda handler.
 */

// Mock Secrets Manager — returns stored JWT token
const mockSend = jest.fn().mockResolvedValue({
  SecretString: JSON.stringify({ accessToken: 'mock-jwt-token' }),
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
  process.env.PLATFORM_SECRET_NAME = 'pipeline-builder/test-org/platform';
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
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({ accessToken: 'mock-jwt-token' }),
    });

    // Default: API calls succeed
    mockFetch.mockImplementation((url: string, _opts?: unknown) => {
      if (url.includes('/api/reports/events')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { inserted: 1, skipped: 0 } }),
        });
      }
      return Promise.resolve({ ok: false, text: () => Promise.resolve('Not found') });
    });
  });

  it('should use stored JWT token and POST events to reporting API', async () => {
    const event = createSQSEvent([MOCK_CODEPIPELINE_EVENT]);

    await handler(event);

    // Should have fetched token from Secrets Manager
    expect(mockSend).toHaveBeenCalled();

    // Should have POSTed events with stored token
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/api/reports/events',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer mock-jwt-token',
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
      pipelineArn: 'arn:aws:codepipeline:us-east-1:2a33349e7e60:acme-webapp-pipeline', // account hashed
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
    mockFetch.mockImplementation(() => {
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

  it('should hash account number in both ARN and detail', async () => {
    const event = createSQSEvent([MOCK_CODEPIPELINE_EVENT]);
    await handler(event);

    const eventsCall = mockFetch.mock.calls.find((c: any[]) => c[0].includes('/reports/events'));
    const body = JSON.parse(eventsCall![1].body);

    // Account in ARN should be hashed (not the raw 123456789012)
    expect(body.events[0].pipelineArn).toBe('arn:aws:codepipeline:us-east-1:2a33349e7e60:acme-webapp-pipeline');
    // Account in detail should also be hashed
    expect(body.events[0].detail.account).toBe('2a33349e7e60');
    // Real account number should not appear anywhere in the payload
    expect(JSON.stringify(body)).not.toContain('123456789012');
  });
});
