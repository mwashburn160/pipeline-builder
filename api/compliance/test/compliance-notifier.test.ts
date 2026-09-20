// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockPost = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockEmailPost = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetPreference = jest.fn<(orgId: string) => Promise<unknown>>();
const mockRecordLog = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockRecordPendingDigest = jest.fn<(...args: unknown[]) => Promise<void>>();

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

// The webhook TRANSPORT is api-core's shared `createWebhookChannel`, and its
// behaviour (pin the vetted IP, refuse redirects, HMAC, caps) is asserted
// against the real code in packages/api-core/test/notification-channels.test.ts.
// Here the factory is stubbed with a recording transport so this suite can
// assert the NOTIFIER's job: that the org's preference (webhookUrl /
// webhookSecret / targetUsers) is plumbed onto the channel target, and that the
// transport's DeliveryResult is what lands in the notification log.
const webhookCtl: { result: Record<string, unknown>; target?: Record<string, unknown>; msg?: Record<string, unknown>; calls: number } =
  { result: { ok: true, code: 200 }, calls: 0 };
const emailCtl: { target?: Record<string, unknown>; calls: number } = { calls: 0 };

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getServiceAuthHeader: () => 'Bearer test-service-token',
  createWebhookChannel: () => ({
    channel: 'webhook',
    deliver: async (msg: Record<string, unknown>, target: Record<string, unknown>) => {
      webhookCtl.calls += 1;
      webhookCtl.msg = msg;
      webhookCtl.target = target;
      return webhookCtl.result;
    },
  }),
  // Run the INJECTED sender for real so the email tests still assert that
  // compliance asks platform to send (it has no SMTP/SES of its own).
  createEmailChannel: (opts: { send: (r: Record<string, unknown>) => Promise<boolean> }) => ({
    channel: 'email',
    deliver: async (msg: Record<string, any>, target: Record<string, any>) => {
      emailCtl.calls += 1;
      emailCtl.target = target;
      try {
        const ok = await opts.send({
          to: target.value,
          orgId: msg.recipientOrgId,
          targetUsers: target.targetUsers ?? null,
          subject: msg.subject,
          text: msg.body,
        });
        return ok ? { ok: true } : { ok: false, error: 'email-send-failed' };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  }),
  createChannelRegistry: (channels: { channel: string }[]) => {
    const byName = new Map(channels.map((c) => [c.channel, c]));
    return (name: string) => byName.get(name) ?? null;
  },
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
    // The spoofable `x-internal-service` header was dropped — routes authenticate
    // via the service JWT, not this header, so nothing trusted it.
    expect(opts.headers['x-internal-service']).toBeUndefined();
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
  beforeEach(() => {
    mockPost.mockReset(); mockPost.mockResolvedValue(undefined);
    mockGetPreference.mockReset();
    mockRecordLog.mockReset(); mockRecordLog.mockResolvedValue(undefined);
    webhookCtl.result = { ok: true, code: 200 };
    webhookCtl.target = undefined; webhookCtl.msg = undefined; webhookCtl.calls = 0;
    emailCtl.target = undefined; emailCtl.calls = 0;
  });

  it('plumbs the org webhookUrl onto the channel target and sends the structured payload', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, webhookUrl: 'https://hook.example/c', webhookSecret: null });
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);

    expect(mockPost).toHaveBeenCalledTimes(1); // in-app still fires
    expect(webhookCtl.calls).toBe(1);
    // The shared transport takes the URL as `target.value` (it was `target.url`
    // in the local fork — the two services disagreed on the field name).
    expect(webhookCtl.target).toMatchObject({ value: 'https://hook.example/c' });
    const payload = webhookCtl.msg?.payload as Record<string, any>;
    expect(payload.event).toBe('compliance.block');
    expect(payload.violations[0].ruleName).toBe('rule-1');
    expect(mockRecordLog).toHaveBeenCalledWith(expect.objectContaining({ channel: 'webhook', status: 'sent', webhookResponseCode: 200 }));
  });

  it('passes the webhookSecret through so the transport can HMAC-sign', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, webhookUrl: 'https://hook.example/c', webhookSecret: 's3cr3t' });
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);

    expect(webhookCtl.target).toMatchObject({ value: 'https://hook.example/c', secret: 's3cr3t' });
  });

  it('omits the secret when the org has not configured one', async () => {
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, webhookUrl: 'https://hook.example/c', webhookSecret: null });
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);

    expect(webhookCtl.target?.secret).toBeUndefined();
  });

  it('logs a failed webhook on non-2xx without affecting in-app', async () => {
    webhookCtl.result = { ok: false, code: 503 };
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, webhookUrl: 'https://hook.example/c', webhookSecret: null });
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);

    expect(mockPost).toHaveBeenCalledTimes(1); // in-app unaffected
    expect(mockRecordLog).toHaveBeenCalledWith(expect.objectContaining({ channel: 'webhook', status: 'failed', webhookResponseCode: 503 }));
  });

  it('records a refused redirect as a failed delivery in the notification log', async () => {
    webhookCtl.result = { ok: false, code: 302, error: 'webhook url redirected (refused)' };
    mockGetPreference.mockResolvedValue({ notifyOnBlock: true, webhookUrl: 'https://hook.example/c' });
    await notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()]);

    expect(mockRecordLog).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'webhook', status: 'failed', webhookResponseCode: 302,
    }));
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
