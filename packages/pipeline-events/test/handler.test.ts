// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for pipeline-events Lambda handler.
 */

import { jest, describe, it, expect, beforeEach, beforeAll } from '@jest/globals';

// Mock Secrets Manager — returns stored JWT token
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
  SecretString: JSON.stringify({ password: 'mock-jwt-token' }),
});
jest.unstable_mockModule('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((params: unknown) => params),
}));

// CodePipeline is loaded by the SUT lazily via dynamic import() (see
// src/index.ts) — mock the module here. `send` resolves the PIPELINE_EVENT_ID
// tag, keyed by the ARN so different pipelines differ.
const mockTagsSend = jest.fn<(cmd: { resourceArn: string }) => Promise<unknown>>();
jest.unstable_mockModule('@aws-sdk/client-codepipeline', () => ({
  CodePipelineClient: jest.fn(() => ({ send: mockTagsSend })),
  ListTagsForResourceCommand: jest.fn((input: unknown) => input),
}));

// Mock fetch globally
const mockFetch = jest.fn<(url: string, opts?: unknown) => Promise<unknown>>();
global.fetch = mockFetch as unknown as typeof fetch;

import type { SQSEvent } from 'aws-lambda';

// Must import after mocks
let handler: (event: SQSEvent) => Promise<void>;

beforeAll(async () => {
  process.env.PLATFORM_BASE_URL = 'https://api.example.com';
  process.env.PLATFORM_SECRET_NAME = 'pipeline-builder/test-org/platform';
  const mod = await import('../src/index.js');
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

/** Resolve PIPELINE_EVENT_ID by the pipeline name embedded in the ARN. */
function tagResolver(cmd: { resourceArn: string }) {
  const arn = cmd.resourceArn;
  if (arn.includes('untagged-pipeline')) return Promise.resolve({ tags: [] });
  if (arn.includes('denied-pipeline')) {
    return Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
  }
  return Promise.resolve({ tags: [{ key: 'PIPELINE_EVENT_ID', value: 'pipeline-uuid-1' }] });
}

describe('pipeline-events handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({ password: 'mock-jwt-token' }),
    });
    mockTagsSend.mockImplementation(tagResolver);

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

  function lastEventsBody() {
    const call = mockFetch.mock.calls.find((c: any[]) => c[0].includes('/reports/events'));
    return call ? JSON.parse(call[1].body) : null;
  }

  it('should use stored JWT token and POST events to reporting API', async () => {
    await handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]));

    expect(mockSend).toHaveBeenCalled(); // token from Secrets Manager
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/api/reports/events',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer mock-jwt-token' }),
      }),
    );
  });

  it('should resolve the PIPELINE_EVENT_ID tag and report against it (no ARN/account)', async () => {
    await handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]));

    const body = lastEventsBody();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      pipelineId: 'pipeline-uuid-1',
      eventSource: 'codepipeline',
      eventType: 'PIPELINE',
      status: 'SUCCEEDED',
      executionId: 'exec-123',
    });
    expect(body.events[0].durationMs).toBe(300000); // 5 minutes
    // The ARN/account never leave AWS — not in the payload.
    expect(body.events[0].pipelineArn).toBeUndefined();
    expect(body.events[0].detail.account).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('123456789012');
    expect(JSON.stringify(body)).not.toContain('arn:aws:codepipeline');
  });

  it('should classify stage events correctly', async () => {
    await handler(createSQSEvent([{
      ...MOCK_CODEPIPELINE_EVENT,
      'detail-type': 'CodePipeline Stage Execution State Change',
      'detail': { ...MOCK_CODEPIPELINE_EVENT.detail, stage: 'Build' },
    }]));

    const body = lastEventsBody();
    expect(body.events[0].eventType).toBe('STAGE');
    expect(body.events[0].stageName).toBe('Build');
  });

  it('should classify action events and promote the failure summary to errorMessage', async () => {
    await handler(createSQSEvent([{
      ...MOCK_CODEPIPELINE_EVENT,
      'detail-type': 'CodePipeline Action Execution State Change',
      'detail': {
        ...MOCK_CODEPIPELINE_EVENT.detail,
        'state': 'FAILED',
        'stage': 'Build',
        'action': 'nodejs-build',
        'execution-result': {
          'external-execution-summary': 'Build failed: exit code 1',
          'external-execution-url': 'https://console.aws/build/123',
        },
      },
    }]));

    const body = lastEventsBody();
    expect(body.events[0].eventType).toBe('ACTION');
    expect(body.events[0].actionName).toBe('nodejs-build');
    expect(body.events[0].errorMessage).toBe('Build failed: exit code 1');
    // The log URL stays in detail for drill-down.
    expect(body.events[0].detail['execution-result']['external-execution-url'])
      .toBe('https://console.aws/build/123');
  });

  it('should handle multiple events in batch', async () => {
    await handler(createSQSEvent([
      MOCK_CODEPIPELINE_EVENT,
      { ...MOCK_CODEPIPELINE_EVENT, detail: { ...MOCK_CODEPIPELINE_EVENT.detail, state: 'FAILED' } },
    ]));
    expect(lastEventsBody().events).toHaveLength(2);
  });

  it('should SKIP events for untagged pipelines (no POST)', async () => {
    await handler(createSQSEvent([{
      ...MOCK_CODEPIPELINE_EVENT,
      detail: { ...MOCK_CODEPIPELINE_EVENT.detail, pipeline: 'untagged-pipeline' },
    }]));
    // No resolvable id → nothing posted to reporting.
    expect(mockFetch.mock.calls.find((c: any[]) => c[0].includes('/reports/events'))).toBeUndefined();
  });

  it('should SKIP CodeBuild (non-pipeline) events', async () => {
    await handler(createSQSEvent([{
      'detail-type': 'CodeBuild Build State Change',
      'source': 'aws.codebuild',
      'detail': { 'build-status': 'FAILED', 'project-name': 'some-project' },
      'time': '2026-03-15T10:05:00Z',
      'region': 'us-east-1',
      'account': '123456789012',
    }]));
    expect(mockFetch.mock.calls.find((c: any[]) => c[0].includes('/reports/events'))).toBeUndefined();
  });

  it('should THROW on AccessDenied so a missing IAM grant surfaces', async () => {
    await expect(handler(createSQSEvent([{
      ...MOCK_CODEPIPELINE_EVENT,
      detail: { ...MOCK_CODEPIPELINE_EVENT.detail, pipeline: 'denied-pipeline' },
    }]))).rejects.toThrow();
  });

  it('should throw if PLATFORM_BASE_URL is not set', async () => {
    const origUrl = process.env.PLATFORM_BASE_URL;
    delete process.env.PLATFORM_BASE_URL;
    await expect(handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]))).rejects.toThrow('PLATFORM_BASE_URL');
    process.env.PLATFORM_BASE_URL = origUrl;
  });

  it('should throw if reporting API returns error', async () => {
    mockFetch.mockImplementation(() => Promise.resolve({
      ok: false, status: 500, text: () => Promise.resolve('Internal Server Error'),
    }));
    await expect(handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]))).rejects.toThrow('Reporting API failed: 500');
  });

  it('should not compute duration for STARTED events', async () => {
    await handler(createSQSEvent([{
      ...MOCK_CODEPIPELINE_EVENT,
      detail: { ...MOCK_CODEPIPELINE_EVENT.detail, state: 'STARTED' },
    }]));
    const body = lastEventsBody();
    expect(body.events[0].durationMs).toBeUndefined();
    expect(body.events[0].completedAt).toBeUndefined();
  });
});
