// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from 'crypto';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockPost = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockEmailPost = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetPreference = jest.fn<(orgId: string) => Promise<unknown>>();
const mockRecordLog = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockRecordPendingDigest = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getServiceAuthHeader: () => 'Bearer test-service-token',
}));

jest.unstable_mockModule('../src/helpers/message-client.js', () => ({
  messageClient: {
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

jest.unstable_mockModule('../src/helpers/email-client.js', () => ({
  emailClient: {
    post: (...args: unknown[]) => mockEmailPost(...args),
  },
}));

// notification-service is the DB layer (preference read + audit-log write);
// mocked so the notifier's orchestration is tested without a Postgres.
jest.unstable_mockModule('../src/services/notification-service.js', () => ({
  getNotificationPreference: (orgId: string) => mockGetPreference(orgId),
  recordNotificationLog: (...args: unknown[]) => mockRecordLog(...args),
  recordPendingDigest: (...args: unknown[]) => mockRecordPendingDigest(...args),
}));

import type { Violation } from '../src/engine/rule-engine.js';
const { notifyComplianceBlock, notifyComplianceWarnings } = await import('../src/helpers/compliance-notifier.js');

function makeViolation(overrides: Partial<Violation> = {}): Violation {
  return {
    ruleId: 'r1',
    ruleName: 'rule-1',
    field: 'name',
    operator: 'eq',
    expectedValue: 'a',
    actualValue: 'b',
    severity: 'error',
    message: 'mismatch',
    suppressNotification: false,
    ...overrides,
  };
}

describe('notifyComplianceBlock', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue(undefined);
    mockEmailPost.mockReset();
    mockEmailPost.mockResolvedValue(undefined);
    mockGetPreference.mockReset();
    mockGetPreference.mockResolvedValue(null); // default: no preference row → notify on
    mockRecordLog.mockReset();
    mockRecordLog.mockResolvedValue(undefined);
    mockRecordPendingDigest.mockReset();
    mockRecordPendingDigest.mockResolvedValue(undefined);
  });

  it('parks a pending digest instead of sending when digestMode is daily/weekly', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, digestMode: 'daily' });
    await notifyComplianceBlock('org-1', 'plugin', 'my-plugin', [makeViolation()]);
    expect(mockRecordPendingDigest).toHaveBeenCalledWith('org-1', expect.objectContaining({ subject: expect.stringContaining('blocked') }));
    expect(mockPost).not.toHaveBeenCalled(); // not delivered immediately
  });

  it('sends a high-priority message with violation details', async () => {
    await notifyComplianceBlock('org-1', 'plugin', 'my-plugin', [makeViolation()]);

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, body, opts] = mockPost.mock.calls[0];
    expect(path).toBe('/messages');
    expect(body.recipientOrgId).toBe('org-1');
    expect(body.priority).toBe('high');
    expect(body.subject).toContain('plugin');
    expect(body.subject).toContain('my-plugin');
    expect(body.content).toContain('rule-1');
    expect(body.content).toContain('mismatch');
    // Always uses a service-minted token now (not the user's bearer).
    expect(opts.headers.Authorization).toBe('Bearer test-service-token');
    expect(opts.headers['x-internal-service']).toBe('true');
  });

  it('skips when all violations have suppressNotification', async () => {
    await notifyComplianceBlock('org-1', 'plugin', 'name', [makeViolation({ suppressNotification: true })]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('skips when violations array is empty', async () => {
    await notifyComplianceBlock('org-1', 'plugin', 'name', []);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('filters out suppressed violations from the summary', async () => {
    await notifyComplianceBlock('org-1', 'plugin', 'p', [
      makeViolation({ ruleName: 'visible' }),
      makeViolation({ ruleName: 'hidden', suppressNotification: true }),
    ]);
    const [, body] = mockPost.mock.calls[0];
    expect(body.content).toContain('visible');
    expect(body.content).not.toContain('hidden');
  });

  it('swallows messageClient errors (fire-and-forget)', async () => {
    mockPost.mockRejectedValue(new Error('boom'));
    await expect(
      notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]),
    ).resolves.toBeUndefined();
  });

  it('combines multiple violations into a single message', async () => {
    await notifyComplianceBlock('org-1', 'pipeline', 'pl', [
      makeViolation({ ruleName: 'r-a', message: 'A failed' }),
      makeViolation({ ruleName: 'r-b', message: 'B failed' }),
    ]);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [, body] = mockPost.mock.calls[0];
    expect(body.content).toContain('r-a');
    expect(body.content).toContain('r-b');
  });

  it('records an in-app delivery in the audit log', async () => {
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);
    expect(mockRecordLog).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', channel: 'in-app', status: 'sent',
    }));
  });

  it('logs a failed status when in-app delivery throws', async () => {
    mockPost.mockRejectedValue(new Error('boom'));
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);
    expect(mockRecordLog).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'in-app', status: 'failed',
    }));
  });
});

describe('notifyComplianceBlock — preference gating', () => {
  beforeEach(() => {
    mockPost.mockReset(); mockPost.mockResolvedValue(undefined);
    mockGetPreference.mockReset();
    mockRecordLog.mockReset(); mockRecordLog.mockResolvedValue(undefined);
  });

  it('suppresses all delivery when notifyOnBlock is off', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnBlock: false, webhookUrl: null });
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockRecordLog).not.toHaveBeenCalled();
  });

  it('still delivers when notifyOnBlock is on and no webhook is set', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, webhookUrl: null });
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

describe('notifyComplianceBlock — webhook channel', () => {
  const fetchMock = jest.fn<typeof fetch>();
  beforeEach(() => {
    mockPost.mockReset(); mockPost.mockResolvedValue(undefined);
    mockGetPreference.mockReset();
    mockRecordLog.mockReset(); mockRecordLog.mockResolvedValue(undefined);
    fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('POSTs the structured payload to the org webhook and logs it', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, webhookUrl: 'https://hook.example/c', webhookSecret: null });
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);

    expect(mockPost).toHaveBeenCalledTimes(1); // in-app still fires
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hook.example/c');
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.event).toBe('compliance.block');
    expect(payload.violations[0].ruleName).toBe('rule-1');
    expect((init as RequestInit).headers as Record<string, string>).not.toHaveProperty('X-PB-Signature');
    expect(mockRecordLog).toHaveBeenCalledWith(expect.objectContaining({ channel: 'webhook', status: 'sent', webhookResponseCode: 200 }));
  });

  it('HMAC-signs the webhook body when a secret is configured', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, webhookUrl: 'https://hook.example/c', webhookSecret: 's3cr3t' });
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const expected = `sha256=${createHmac('sha256', 's3cr3t').update(init.body as string).digest('hex')}`;
    expect((init.headers as Record<string, string>)['X-PB-Signature']).toBe(expected);
  });

  it('logs a failed webhook on non-2xx without affecting in-app', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, webhookUrl: 'https://hook.example/c', webhookSecret: null });
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);
    expect(mockRecordLog).toHaveBeenCalledWith(expect.objectContaining({ channel: 'webhook', status: 'failed', webhookResponseCode: 503 }));
  });
});

describe('notifyComplianceBlock — email channel', () => {
  beforeEach(() => {
    mockPost.mockReset(); mockPost.mockResolvedValue(undefined);
    mockEmailPost.mockReset(); mockEmailPost.mockResolvedValue(undefined);
    mockGetPreference.mockReset();
    mockRecordLog.mockReset(); mockRecordLog.mockResolvedValue(undefined);
  });

  it('does not email when emailEnabled is off', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, emailEnabled: false });
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);
    expect(mockEmailPost).not.toHaveBeenCalled();
  });

  it('POSTs orgId + targetUsers + subject/text to platform when emailEnabled', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, emailEnabled: true, targetUsers: ['u1', 'u2'] });
    await notifyComplianceBlock('org-1', 'plugin', 'my-plugin', [makeViolation()]);

    expect(mockPost).toHaveBeenCalledTimes(1); // in-app still fires
    expect(mockEmailPost).toHaveBeenCalledTimes(1);
    const [path, body] = mockEmailPost.mock.calls[0];
    expect(path).toBe('/internal/notify-email');
    expect(body.orgId).toBe('org-1');
    expect(body.targetUsers).toEqual(['u1', 'u2']);
    expect(body.subject).toContain('my-plugin');
    expect(body.text).toContain('rule-1');
    expect(mockRecordLog).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email', status: 'sent' }));
  });

  it('passes targetUsers: null (all admins) when unset, and logs a failed email when the call throws', async () => {
    mockEmailPost.mockRejectedValue(new Error('platform down'));
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, emailEnabled: true, targetUsers: null });
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);
    expect(mockEmailPost.mock.calls[0][1].targetUsers).toBeNull();
    expect(mockRecordLog).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email', status: 'failed' }));
  });
});

describe('notifyComplianceWarnings', () => {
  beforeEach(() => {
    mockPost.mockReset(); mockPost.mockResolvedValue(undefined);
    mockEmailPost.mockReset(); mockEmailPost.mockResolvedValue(undefined);
    mockGetPreference.mockReset();
    mockRecordLog.mockReset(); mockRecordLog.mockResolvedValue(undefined);
  });

  it('does nothing without a preference (opt-in; default off)', async () => {
    mockGetPreference.mockResolvedValue(null);
    await notifyComplianceWarnings('org-1', 'plugin', 'p', [makeViolation({ severity: 'warning' })]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('does nothing when notifyOnWarning is off', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnWarning: false });
    await notifyComplianceWarnings('org-1', 'plugin', 'p', [makeViolation({ severity: 'warning' })]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('delivers a normal-priority warning notification when notifyOnWarning is on', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnWarning: true });
    await notifyComplianceWarnings('org-1', 'plugin', 'my-plugin', [makeViolation({ ruleName: 'warn-rule', severity: 'warning' })]);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [, body] = mockPost.mock.calls[0];
    expect(body.priority).toBe('normal');
    expect(body.subject).toContain('warnings');
    expect(body.content).toContain('warn-rule');
    expect(mockRecordLog).toHaveBeenCalledWith(expect.objectContaining({ channel: 'in-app', status: 'sent' }));
  });

  it('skips when all warnings are suppressed', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnWarning: true });
    await notifyComplianceWarnings('org-1', 'plugin', 'p', [makeViolation({ severity: 'warning', suppressNotification: true })]);
    expect(mockPost).not.toHaveBeenCalled();
  });
});
