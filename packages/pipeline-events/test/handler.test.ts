// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for pipeline-events Lambda handler.
 */

import { jest, describe, it, expect, beforeEach, beforeAll } from '@jest/globals';

// Mock Secrets Manager — returns stored JWT token (platform secret) for any id.
// The github-token secret path resolves to the same string, which is fine: the
// commit-resolution tests mock the SCM fetch response regardless of the auth header.
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
  SecretString: JSON.stringify({ password: 'mock-jwt-token' }),
});
jest.unstable_mockModule('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((params: unknown) => params),
}));

// CodePipeline is loaded by the SUT lazily via dynamic import() (see src/index.ts) —
// mock the module here. `send` resolves the pb.pipeline-id / pb.deploys tags, keyed
// by the ARN so different pipelines differ.
const mockTagsSend = jest.fn<(cmd: { resourceArn: string }) => Promise<unknown>>();
jest.unstable_mockModule('@aws-sdk/client-codepipeline', () => ({
  CodePipelineClient: jest.fn(() => ({ send: mockTagsSend })),
  ListTagsForResourceCommand: jest.fn((input: unknown) => input),
}));

// SQS (Phase 3 self-healing redrive) and CodeCommit (Phase 4 commit resolution) are
// NOT real dependencies of this package — they exist only in the Lambda runtime. The
// handler dynamic-imports them by name; jest's moduleNameMapper points both to
// test/aws-sdk-stub.js (see package.json), whose clients call these send fns via
// globalThis so we can install mocks and assert on the issued commands.
const mockSqsSend = jest.fn<(cmd: Record<string, unknown>) => Promise<unknown>>();
const mockCcSend = jest.fn<(cmd: Record<string, unknown>) => Promise<unknown>>();
(globalThis as any).__sqsSend = mockSqsSend;
(globalThis as any).__ccSend = mockCcSend;

// Mock fetch globally
const mockFetch = jest.fn<(url: string, opts?: unknown) => Promise<unknown>>();
global.fetch = mockFetch as unknown as typeof fetch;

import type { SQSEvent } from 'aws-lambda';

// Must import after mocks
let handler: (event: SQSEvent) => Promise<void>;
let resetForTests: () => void;

beforeAll(async () => {
  process.env.PLATFORM_BASE_URL = 'https://api.example.com';
  process.env.PLATFORM_SECRET_NAME = 'pipeline-builder/test-org/platform';
  const mod = await import('../src/index.js');
  handler = mod.handler;
  resetForTests = mod._resetForTests;
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

/** Resolve pb.pipeline-id (+ pb.deploys) by the pipeline name embedded in the ARN. */
function tagResolver(cmd: { resourceArn: string }) {
  const arn = cmd.resourceArn;
  if (arn.includes('untagged-pipeline')) return Promise.resolve({ tags: [] });
  if (arn.includes('denied-pipeline')) {
    return Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
  }
  // A pipeline that declares a deploy stage surfaces a pb.deploys tag mapping the
  // stage name → environment (DORA deploy attribution).
  if (arn.includes('prod-pipeline')) {
    return Promise.resolve({
      tags: [
        { key: 'pb.pipeline-id', value: 'pipeline-uuid-1' },
        { key: 'pb.deploys', value: 'Deploy:production' },
      ],
    });
  }
  return Promise.resolve({ tags: [{ key: 'pb.pipeline-id', value: 'pipeline-uuid-1' }] });
}

describe('pipeline-events handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetForTests();
    // DORA commit enrichment is gated on DORA_ENABLED (`setup-events --with-dora`).
    // Off by default; the Phase-4 block turns it on (its beforeEach runs after this).
    delete process.env.DORA_ENABLED;
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({ password: 'mock-jwt-token' }),
    });
    mockTagsSend.mockImplementation(tagResolver);

    // Default SQS: empty DLQ, no active move task → no redrive.
    mockSqsSend.mockImplementation((cmd) => {
      if (cmd.__type === 'GetQueueAttributes') return Promise.resolve({ Attributes: { ApproximateNumberOfMessages: '0' } });
      if (cmd.__type === 'ListMessageMoveTasks') return Promise.resolve({ Results: [] });
      return Promise.resolve({ TaskHandle: 'task-1' });
    });

    // Default: API calls succeed; anything else 404s (health POST tolerates this).
    mockFetch.mockImplementation((url: string, _opts?: unknown) => {
      if (url.includes('/api/reports/events')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { inserted: 1, skipped: 0 } }),
        });
      }
      if (url.includes('/api/reports/ingest-health')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('Not found') });
    });
  });

  function lastEventsBody() {
    const call = mockFetch.mock.calls.find((c: any[]) => c[0].includes('/reports/events'));
    return call ? JSON.parse(call[1].body) : null;
  }

  function ingestHealthBody() {
    const call = mockFetch.mock.calls.find((c: any[]) => c[0].includes('/reports/ingest-health'));
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

  it('should resolve the pb.pipeline-id tag and report against it (no ARN/account)', async () => {
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

  describe('Phase 1 — pb.deploys → per-stage environment', () => {
    it('should set environment on a deploy-stage STAGE event listed in pb.deploys', async () => {
      await handler(createSQSEvent([{
        ...MOCK_CODEPIPELINE_EVENT,
        'detail-type': 'CodePipeline Stage Execution State Change',
        'detail': {
          ...MOCK_CODEPIPELINE_EVENT.detail,
          'pipeline': 'prod-pipeline',
          'stage': 'Deploy',
          'source-revisions': [{ revisionId: 'abc123def456', branchName: 'main' }],
        },
      }]));

      const body = lastEventsBody();
      expect(body.events).toHaveLength(1);
      expect(body.events[0]).toMatchObject({
        pipelineId: 'pipeline-uuid-1',
        eventType: 'STAGE',
        stageName: 'Deploy',
        commitSha: 'abc123def456',
        commitRef: 'main',
        environment: 'production',
      });
    });

    it('should NOT set environment on a non-deploy stage (not in pb.deploys)', async () => {
      await handler(createSQSEvent([{
        ...MOCK_CODEPIPELINE_EVENT,
        'detail-type': 'CodePipeline Stage Execution State Change',
        'detail': { ...MOCK_CODEPIPELINE_EVENT.detail, pipeline: 'prod-pipeline', stage: 'Build' },
      }]));
      expect(lastEventsBody().events[0].environment).toBeUndefined();
    });

    it('should NOT set environment on a PIPELINE event (no stage ⇒ not a deploy)', async () => {
      await handler(createSQSEvent([{
        ...MOCK_CODEPIPELINE_EVENT,
        detail: { ...MOCK_CODEPIPELINE_EVENT.detail, pipeline: 'prod-pipeline' },
      }]));
      expect(lastEventsBody().events[0].environment).toBeUndefined();
    });

    it('should leave commit/ref/environment undefined for events with no revision and no deploy stage', async () => {
      await handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]));
      const body = lastEventsBody();
      expect(body.events[0].commitSha).toBeUndefined();
      expect(body.events[0].commitRef).toBeUndefined();
      expect(body.events[0].environment).toBeUndefined();
    });
  });

  describe('Phase 4 — in-account commit range (commitTimestamp/commitCount)', () => {
    // Commit enrichment only runs when DORA is enabled (setup-events --with-dora).
    beforeEach(() => { process.env.DORA_ENABLED = 'true'; });

    it('skips commit resolution (no SCM call) when DORA is disabled, even with a valid source', async () => {
      delete process.env.DORA_ENABLED; // entitlement gate off (org without advanced_reporting)
      await handler(createSQSEvent([{
        ...MOCK_CODEPIPELINE_EVENT,
        detail: {
          ...MOCK_CODEPIPELINE_EVENT.detail,
          'source-revisions': [{
            revisionId: 'deadbeef',
            branchName: 'main',
            revisionUrl: 'https://us-east-1.console.aws.amazon.com/codesuite/codecommit/repositories/my-repo/commits/deadbeef?region=us-east-1',
          }],
        },
      }]));
      const body = lastEventsBody();
      expect(body.events[0].commitSha).toBe('deadbeef');        // standard reporting still forwards
      expect(body.events[0].commitTimestamp).toBeUndefined();   // DORA enrichment skipped
      expect(body.events[0].commitCount).toBeUndefined();
      expect(mockCcSend).not.toHaveBeenCalled();                // no CodeCommit GetCommit
    });

    it('resolves a CodeCommit commit timestamp via GetCommit (single commit, cold start)', async () => {
      mockCcSend.mockImplementation(() => Promise.resolve({
        commit: { committer: { date: '1710000000 +0000' }, parents: ['cafebabe'] },
      }));
      await handler(createSQSEvent([{
        ...MOCK_CODEPIPELINE_EVENT,
        detail: {
          ...MOCK_CODEPIPELINE_EVENT.detail,
          'source-revisions': [{
            revisionId: 'deadbeef',
            branchName: 'main',
            revisionUrl: 'https://us-east-1.console.aws.amazon.com/codesuite/codecommit/repositories/my-repo/commits/deadbeef?region=us-east-1',
          }],
        },
      }]));

      const body = lastEventsBody();
      expect(body.events[0].commitSha).toBe('deadbeef');
      expect(body.events[0].commitTimestamp).toBe(new Date(1710000000 * 1000).toISOString());
      expect(body.events[0].commitCount).toBe(1);
      expect(mockCcSend).toHaveBeenCalled();
    });

    it('resolves a GitHub commit timestamp via the commits API', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('api.github.com')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ commit: { committer: { date: '2026-03-14T09:00:00Z' } } }) });
        }
        if (url.includes('/api/reports/events')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) });
        if (url.includes('/api/reports/ingest-health')) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('nf') });
      });

      await handler(createSQSEvent([{
        ...MOCK_CODEPIPELINE_EVENT,
        detail: {
          ...MOCK_CODEPIPELINE_EVENT.detail,
          'source-revisions': [{
            revisionId: 'abc123',
            branchName: 'main',
            revisionUrl: 'https://github.com/acme/webapp/commit/abc123',
          }],
        },
      }]));

      const body = lastEventsBody();
      expect(body.events[0].commitTimestamp).toBe('2026-03-14T09:00:00.000Z');
      expect(body.events[0].commitCount).toBe(1);
      const ghCall = mockFetch.mock.calls.find((c: any[]) => c[0].includes('api.github.com'));
      expect(ghCall[0]).toContain('/repos/acme/webapp/commits/abc123');
    });

    it('omits commitTimestamp/commitCount when the source type is unknown (no revisionUrl)', async () => {
      await handler(createSQSEvent([{
        ...MOCK_CODEPIPELINE_EVENT,
        detail: {
          ...MOCK_CODEPIPELINE_EVENT.detail,
          'source-revisions': [{ revisionId: 'abc123', branchName: 'main' }],
        },
      }]));
      const body = lastEventsBody();
      expect(body.events[0].commitSha).toBe('abc123');
      expect(body.events[0].commitTimestamp).toBeUndefined();
      expect(body.events[0].commitCount).toBeUndefined();
      // No SCM calls attempted for an unknown source.
      expect(mockFetch.mock.calls.find((c: any[]) => c[0].includes('api.github.com'))).toBeUndefined();
      expect(mockCcSend).not.toHaveBeenCalled();
    });

    it('omits the fields (never fails the batch) when commit resolution errors', async () => {
      mockCcSend.mockImplementation(() => Promise.reject(new Error('boom')));
      await expect(handler(createSQSEvent([{
        ...MOCK_CODEPIPELINE_EVENT,
        detail: {
          ...MOCK_CODEPIPELINE_EVENT.detail,
          'source-revisions': [{
            revisionId: 'deadbeef',
            revisionUrl: 'https://console.aws.amazon.com/codesuite/codecommit/repositories/my-repo/commits/deadbeef',
          }],
        },
      }]))).resolves.toBeUndefined();
      const body = lastEventsBody();
      expect(body.events[0].commitTimestamp).toBeUndefined();
      expect(body.events[0].commitCount).toBeUndefined();
    });
  });

  describe('Phase 3 — ingest-health + self-healing DLQ redrive', () => {
    it('POSTs ingest-health after a successful batch (forwarded + lastEventAt)', async () => {
      await handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]));
      const health = ingestHealthBody();
      expect(health).toMatchObject({ forwarded: 1, dropped: 0, lastEventAt: '2026-03-15T10:05:00Z' });
    });

    it('starts a DLQ→main move task when the DLQ is non-empty and none is running', async () => {
      mockSqsSend.mockImplementation((cmd) => {
        if (cmd.__type === 'GetQueueAttributes') return Promise.resolve({ Attributes: { ApproximateNumberOfMessages: '5' } });
        if (cmd.__type === 'ListMessageMoveTasks') return Promise.resolve({ Results: [] });
        return Promise.resolve({ TaskHandle: 'task-1' });
      });

      await handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]));

      const move = mockSqsSend.mock.calls.find((c: any[]) => c[0].__type === 'StartMessageMoveTask');
      expect(move).toBeDefined();
      expect(move[0].SourceArn).toBe('arn:aws:sqs:us-east-1:123:pipeline-builder-events-dlq');
      expect(move[0].DestinationArn).toBe('arn:aws:sqs:us-east-1:123:pipeline-builder-events');
      // Health still reports the current DLQ depth as `dropped`.
      expect(ingestHealthBody()).toMatchObject({ dropped: 5 });
    });

    it('does NOT start a move task when one is already running (one-at-a-time)', async () => {
      mockSqsSend.mockImplementation((cmd) => {
        if (cmd.__type === 'GetQueueAttributes') return Promise.resolve({ Attributes: { ApproximateNumberOfMessages: '5' } });
        if (cmd.__type === 'ListMessageMoveTasks') return Promise.resolve({ Results: [{ Status: 'RUNNING' }] });
        return Promise.resolve({ TaskHandle: 'task-1' });
      });

      await handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]));
      expect(mockSqsSend.mock.calls.find((c: any[]) => c[0].__type === 'StartMessageMoveTask')).toBeUndefined();
    });

    it('does NOT start a move task when the DLQ is empty', async () => {
      await handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]));
      expect(mockSqsSend.mock.calls.find((c: any[]) => c[0].__type === 'StartMessageMoveTask')).toBeUndefined();
    });

    it('never fails the batch when the redrive machinery throws', async () => {
      mockSqsSend.mockImplementation(() => Promise.reject(new Error('sqs boom')));
      await expect(handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]))).resolves.toBeUndefined();
      // The events batch still posted successfully.
      expect(lastEventsBody().events).toHaveLength(1);
    });
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

  it('does NOT emit the removed idempotencyKey field (dedupe is the ingest DB partial-unique index)', async () => {
    await handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]));
    const body = lastEventsBody();
    expect(body.events[0]).not.toHaveProperty('idempotencyKey');
    // The internal orgId keying field is stripped before the wire, too.
    expect(body.events[0]).not.toHaveProperty('orgId');
  });

  describe('per-org GitHub token (packages#5)', () => {
    beforeEach(() => { process.env.DORA_ENABLED = 'true'; });

    it('selects the github-token secret for the RESOLVED org, not the container org', async () => {
      mockTagsSend.mockImplementation((cmd: { resourceArn: string }) => {
        if (cmd.resourceArn.includes('org-pipeline')) {
          return Promise.resolve({ tags: [
            { key: 'pb.pipeline-id', value: 'pipeline-uuid-9' },
            { key: 'OrgId', value: 'org-xyz' },
          ] });
        }
        return tagResolver(cmd);
      });
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('api.github.com')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ commit: { committer: { date: '2026-03-14T09:00:00Z' } } }) });
        if (url.includes('/api/reports/events')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) });
        if (url.includes('/api/reports/ingest-health')) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('nf') });
      });

      await handler(createSQSEvent([{
        ...MOCK_CODEPIPELINE_EVENT,
        detail: {
          ...MOCK_CODEPIPELINE_EVENT.detail,
          pipeline: 'org-pipeline',
          'source-revisions': [{ revisionId: 'abc123', revisionUrl: 'https://github.com/acme/webapp/commit/abc123' }],
        },
      }]));

      const ghSecretCall = mockSend.mock.calls.find((c: any[]) => String(c[0]?.SecretId ?? '').includes('github-token'));
      expect(ghSecretCall).toBeDefined();
      expect(ghSecretCall![0].SecretId).toBe('pipeline-builder/org-xyz/github-token');
    });
  });

  describe('ingest-health per resolved org (packages#6)', () => {
    it('posts a separate ingest-health signal per org with its own forwarded count', async () => {
      mockTagsSend.mockImplementation((cmd: { resourceArn: string }) => {
        if (cmd.resourceArn.includes('org-a-pipeline')) return Promise.resolve({ tags: [{ key: 'pb.pipeline-id', value: 'p-a' }, { key: 'OrgId', value: 'org-a' }] });
        if (cmd.resourceArn.includes('org-b-pipeline')) return Promise.resolve({ tags: [{ key: 'pb.pipeline-id', value: 'p-b' }, { key: 'OrgId', value: 'org-b' }] });
        return tagResolver(cmd);
      });

      await handler(createSQSEvent([
        { ...MOCK_CODEPIPELINE_EVENT, detail: { ...MOCK_CODEPIPELINE_EVENT.detail, pipeline: 'org-a-pipeline' } },
        { ...MOCK_CODEPIPELINE_EVENT, detail: { ...MOCK_CODEPIPELINE_EVENT.detail, pipeline: 'org-b-pipeline' } },
        { ...MOCK_CODEPIPELINE_EVENT, detail: { ...MOCK_CODEPIPELINE_EVENT.detail, pipeline: 'org-b-pipeline', state: 'FAILED' } },
      ]));

      const healthCalls = mockFetch.mock.calls
        .filter((c: any[]) => c[0].includes('/reports/ingest-health'))
        .map((c: any[]) => JSON.parse(c[1].body));
      const a = healthCalls.find((h: any) => h.orgId === 'org-a');
      const b = healthCalls.find((h: any) => h.orgId === 'org-b');
      expect(a).toMatchObject({ orgId: 'org-a', forwarded: 1 });
      expect(b).toMatchObject({ orgId: 'org-b', forwarded: 2 });
    });

    it('resets an org forwarded counter ONLY after a confirmed 2xx health POST (packages#8)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-03-15T12:00:00Z'));
      // ingest-health fails the first time → forwarded MUST NOT be zeroed.
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/reports/events')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) });
        if (url.includes('/api/reports/ingest-health')) return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('down') });
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('nf') });
      });
      await handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]));
      const firstHealth = ingestHealthBody();
      expect(firstHealth.forwarded).toBe(1);

      // Advance past the health throttle; this time ingest-health succeeds. The
      // un-acked event from the first batch is still counted → forwarded === 2.
      jest.setSystemTime(new Date('2026-03-15T12:02:00Z'));
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/reports/events')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) });
        if (url.includes('/api/reports/ingest-health')) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('nf') });
      });
      await handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]));

      const healthBodies = mockFetch.mock.calls
        .filter((c: any[]) => c[0].includes('/reports/ingest-health'))
        .map((c: any[]) => JSON.parse(c[1].body));
      expect(healthBodies[healthBodies.length - 1].forwarded).toBe(2);
      jest.useRealTimers();
    });
  });

  describe('DLQ poison-message ceiling (packages#B)', () => {
    it('does NOT redrive when the oldest DLQ message exceeds the poison-age ceiling', async () => {
      mockSqsSend.mockImplementation((cmd) => {
        if (cmd.__type === 'GetQueueAttributes') return Promise.resolve({ Attributes: { ApproximateNumberOfMessages: '5', ApproximateAgeOfOldestMessage: String(7 * 60 * 60) } });
        if (cmd.__type === 'ListMessageMoveTasks') return Promise.resolve({ Results: [] });
        return Promise.resolve({ TaskHandle: 'task-1' });
      });

      await handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]));

      expect(mockSqsSend.mock.calls.find((c: any[]) => c[0].__type === 'StartMessageMoveTask')).toBeUndefined();
      // Depth is still reported so the UI can show the stuck DLQ.
      expect(ingestHealthBody().dropped).toBe(5);
    });

    it('DOES redrive when the oldest DLQ message is within the ceiling', async () => {
      mockSqsSend.mockImplementation((cmd) => {
        if (cmd.__type === 'GetQueueAttributes') return Promise.resolve({ Attributes: { ApproximateNumberOfMessages: '3', ApproximateAgeOfOldestMessage: String(60) } });
        if (cmd.__type === 'ListMessageMoveTasks') return Promise.resolve({ Results: [] });
        return Promise.resolve({ TaskHandle: 'task-1' });
      });

      await handler(createSQSEvent([MOCK_CODEPIPELINE_EVENT]));
      expect(mockSqsSend.mock.calls.find((c: any[]) => c[0].__type === 'StartMessageMoveTask')).toBeDefined();
    });
  });

  describe('CodeCommit walk-cap omission (packages#7)', () => {
    beforeEach(() => { process.env.DORA_ENABLED = 'true'; });

    it('omits commitTimestamp/commitCount when the range walk hits MAX_COMMIT_WALK (no understated lead time)', async () => {
      let n = 0;
      // Every commit resolves to a date + an ever-fresh parent, so the second
      // event's range walk NEVER reaches the boundary → it truncates at the cap.
      mockCcSend.mockImplementation((cmd: any) => Promise.resolve({
        commit: { committer: { date: '1710000000 +0000' }, parents: [`p-${cmd.commitId}-${++n}`] },
      }));

      const ccEvent = (sha: string) => ({
        ...MOCK_CODEPIPELINE_EVENT,
        detail: {
          ...MOCK_CODEPIPELINE_EVENT.detail,
          'execution-id': `exec-${sha}`,
          'source-revisions': [{ revisionId: sha, revisionUrl: `https://console.aws.amazon.com/codesuite/codecommit/repositories/my-repo/commits/${sha}` }],
        },
      });

      // First event: single commit (cold start) → establishes the range lower bound.
      await handler(createSQSEvent([ccEvent('head1')]));
      // Second event: range walk head2 → … never hits head1 within MAX_COMMIT_WALK.
      await handler(createSQSEvent([ccEvent('head2')]));

      const eventsCalls = mockFetch.mock.calls.filter((c: any[]) => c[0].includes('/reports/events'));
      const body = JSON.parse(eventsCalls[eventsCalls.length - 1][1].body);
      expect(body.events[0].commitSha).toBe('head2');
      expect(body.events[0].commitTimestamp).toBeUndefined();
      expect(body.events[0].commitCount).toBeUndefined();
    });
  });
});
