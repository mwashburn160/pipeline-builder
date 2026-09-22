// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance's notification channels.
 *
 * The webhook and email TRANSPORTS are api-core's shared factories now, and
 * their behaviour — pin the vetted IP, refuse redirects, HMAC when a secret is
 * present, cap body + time, skipped/dedupe semantics — is asserted against the
 * real code in `packages/api-core/test/notification-channels.test.ts`. Asserting
 * it again here would test the same code twice.
 *
 * What belongs to compliance, and so to this file: WHICH channels it registers,
 * that it builds them from the shared factories, the arguments it configures
 * them with, and its own `in-app` transport (the one transport that legitimately
 * differs per service — compliance sends a system notification through the
 * message service, platform writes the shared table directly).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Records what the shared factories were configured with, and stands in for
 *  the transports they return. */
const webhookOpts: Record<string, any>[] = [];
const emailOpts: Record<string, any>[] = [];
const mockWebhookDeliver = jest.fn<(...a: any[]) => Promise<any>>(async () => ({ ok: true, code: 200 }));
const mockEmailDeliver = jest.fn<(...a: any[]) => Promise<any>>(async () => ({ ok: true }));

const mockSendSystemNotification = jest.fn<(...a: any[]) => Promise<boolean>>(async () => true);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSystemNotification: (...a: any[]) => mockSendSystemNotification(...a),
  getServiceAuthHeader: (opts: { orgId?: string }) => `Bearer test-service-token:${opts?.orgId}`,
  createWebhookChannel: (opts: Record<string, any> = {}) => {
    webhookOpts.push(opts);
    return { channel: opts.name ?? 'webhook', deliver: mockWebhookDeliver };
  },
  createEmailChannel: (opts: Record<string, any>) => {
    emailOpts.push(opts);
    return { channel: 'email', deliver: mockEmailDeliver };
  },
  createChannelRegistry: (channels: { channel: string }[]) => {
    const byName = new Map(channels.map((c) => [c.channel, c]));
    return (name: string) => byName.get(name) ?? null;
  },
}));

// notification-channels imports this client at module load; stub so its real
// InternalHttpClient import doesn't run.
const mockEmailPost = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => undefined);
jest.unstable_mockModule('../src/helpers/email-client.js', () => ({
  emailClient: { post: (...a: unknown[]) => mockEmailPost(...a) },
}));

const { inAppChannel, getNotificationChannel } =
  await import('../src/helpers/notification-channels.js');

const notification = {
  recipientOrgId: 'org-1',
  subject: 's',
  body: 'c',
  priority: 'normal' as const,
  messageType: 'announcement' as const,
  payload: { foo: 'bar' },
};

beforeEach(() => {
  mockSendSystemNotification.mockClear();
  mockSendSystemNotification.mockResolvedValue(true);
  mockEmailPost.mockClear();
  mockEmailPost.mockResolvedValue({ statusCode: 200, body: {} });
});

describe('channel registry', () => {
  it('exposes exactly the three compliance channels', () => {
    for (const c of ['in-app', 'webhook', 'email']) {
      expect(getNotificationChannel(c)?.channel).toBe(c);
    }
    // `slack` is platform's alert-relay channel, not compliance's.
    expect(getNotificationChannel('slack')).toBeNull();
    // Channel names are DB data, so an unknown value must not throw.
    expect(getNotificationChannel('pagerduty')).toBeNull();
  });

  it('builds webhook + email from the SHARED api-core factories, not a local fork', () => {
    expect(webhookOpts).toHaveLength(1);
    expect(emailOpts).toHaveLength(1);
    // Compliance takes the generic webhook (no custom name/renderer): the org's
    // configured payload is forwarded verbatim.
    expect(webhookOpts[0].name).toBeUndefined();
    expect(webhookOpts[0].render).toBeUndefined();
  });
});

describe('email channel configuration', () => {
  it('delegates the actual send to platform, which resolves the recipients', async () => {
    // Compliance has no SMTP/SES of its own, so its injected sender asks
    // platform to send on its behalf.
    await emailOpts[0].send({
      orgId: 'org-9', targetUsers: ['u1'], subject: 'subj', text: 'body text',
    });

    expect(mockEmailPost).toHaveBeenCalledTimes(1);
    const [path, payload] = mockEmailPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/internal/notify-email');
    expect(payload).toMatchObject({
      orgId: 'org-9', targetUsers: ['u1'], subject: 'subj', text: 'body text',
    });
    // The token is scoped to the tenant it emails — platform's relay refuses a
    // service token whose org differs from the body's.
    const opts = mockEmailPost.mock.calls[0][2] as { headers: Record<string, string> };
    expect(opts.headers.Authorization).toBe('Bearer test-service-token:org-9');
  });

  it('passes targetUsers: null through as "every org admin"', async () => {
    await emailOpts[0].send({ orgId: 'org-9', targetUsers: null, subject: 's', text: 't' });
    const [, payload] = mockEmailPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.targetUsers).toBeNull();
  });

  it('reports sent only for a 2xx from platform', async () => {
    await expect(emailOpts[0].send({ orgId: 'org-9', targetUsers: null, subject: 's', text: 't' }))
      .resolves.toBe(true);
  });

  // The HTTP client resolves (does not throw) on 4xx/5xx; treating that as sent
  // made the notifier record a refused/failed email as delivered.
  it.each([403, 500])('reports NOT sent when platform answers %i', async (statusCode) => {
    mockEmailPost.mockResolvedValueOnce({ statusCode, body: { message: 'nope' } });
    await expect(emailOpts[0].send({ orgId: 'org-9', targetUsers: null, subject: 's', text: 't' }))
      .resolves.toBe(false);
  });
});

describe('inAppChannel (the one transport that stays per-service)', () => {
  it('sends a system notification, mapping the shared `body` onto `content`', async () => {
    const result = await inAppChannel.deliver(notification, {});

    expect(result).toEqual({ ok: true });
    expect(mockSendSystemNotification).toHaveBeenCalledWith({
      recipientOrgId: 'org-1',
      subject: 's',
      content: 'c',
      priority: 'normal',
    });
  });

  it('reports failed when the message service does not accept it (4xx/5xx/unreachable)', async () => {
    mockSendSystemNotification.mockResolvedValueOnce(false);
    const result = await inAppChannel.deliver(notification, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not accept/);
  });
});
