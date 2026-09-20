// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance's notification channels.
 *
 * The webhook and email TRANSPORTS are api-core's shared factories now, and
 * their behaviour — pin the vetted IP, refuse redirects, HMAC when a secret is
 * present, cap body + time, skipped/dedupe semantics — is asserted against the
 * real code in `packages/api-core/test/notification-channels.test.ts`. Asserting
 * it again here would test the same code twice; the compliance-local fork that
 * used to justify it is gone.
 *
 * What belongs to compliance, and so to this file: WHICH channels it registers,
 * that it builds them from the shared factories, the arguments it configures
 * them with, and its own `in-app` transport (the one transport that legitimately
 * differs per service — compliance posts to the message service over HTTP,
 * platform writes the shared table directly).
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

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getServiceAuthHeader: () => 'Bearer test-service-token',
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

// notification-channels imports these clients at module load; stub so their real
// InternalHttpClient imports don't run.
const mockMessagePost = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => undefined);
const mockEmailPost = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => undefined);
jest.unstable_mockModule('../src/helpers/message-client.js', () => ({
  messageClient: { post: (...a: unknown[]) => mockMessagePost(...a) },
}));
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
  mockMessagePost.mockClear();
  mockMessagePost.mockResolvedValue(undefined);
  mockEmailPost.mockClear();
  mockEmailPost.mockResolvedValue(undefined);
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
  });

  it('passes targetUsers: null through as "every org admin"', async () => {
    await emailOpts[0].send({ orgId: 'org-9', targetUsers: null, subject: 's', text: 't' });
    const [, payload] = mockEmailPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.targetUsers).toBeNull();
  });
});

describe('inAppChannel (the one transport that stays per-service)', () => {
  it('posts to the message service, mapping the shared `body` onto `content`', async () => {
    const result = await inAppChannel.deliver(notification, {});

    expect(result).toEqual({ ok: true });
    expect(mockMessagePost).toHaveBeenCalledTimes(1);
    const [path, payload] = mockMessagePost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/messages');
    expect(payload).toMatchObject({
      recipientOrgId: 'org-1',
      messageType: 'announcement',
      subject: 's',
      content: 'c',
      priority: 'normal',
    });
  });

  it('authors the cross-tenant write as the system org with a service token', async () => {
    await inAppChannel.deliver(notification, {});
    const [, , opts] = mockMessagePost.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
    // A user bearer cannot write across tenants — it must be service-minted.
    expect(opts.headers.Authorization).toBe('Bearer test-service-token');
    expect(opts.headers['x-org-id']).toBeDefined();
  });

  it('reports failed (not thrown) when the message service rejects', async () => {
    mockMessagePost.mockRejectedValueOnce(new Error('message service down'));
    const result = await inAppChannel.deliver(notification, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/message service down/);
  });
});
