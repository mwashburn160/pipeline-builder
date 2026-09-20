// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared notification TRANSPORTS (services/notification-channels).
 *
 * Platform's alert relay and compliance's notifier each used to carry their own
 * webhook sender, with incompatible contracts and two different SSRF postures.
 * Both now use these, so the transport guarantees are asserted ONCE, here,
 * against the real code: only `https` and `dns/promises` are stubbed, so the
 * actual `safeFetch` — resolve, PIN the vetted address into the socket, refuse
 * redirects — runs for real underneath.
 *
 * The services' own tests cover only what is theirs: which channels they
 * register, how they map their domain object onto the shared message, and their
 * per-service `in-app` transport.
 */

import { createHmac } from 'crypto';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockLookup = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

/** Records the options/body handed to the socket, and drives the response. */
const ctl: { status: number; options: Record<string, any> | null; body?: string; calls: number } =
  { status: 200, options: null, calls: 0 };

const requestStub = (options: Record<string, any>, cb: (res: any) => void) => {
  ctl.calls += 1;
  ctl.options = options;
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
  const res: any = {
    statusCode: ctl.status,
    statusMessage: 'OK',
    headers: {},
    resume: () => { setImmediate(() => listeners.end?.forEach((f) => f())); },
    destroy: () => {},
    on: (ev: string, fn: (arg?: unknown) => void) => { (listeners[ev] ??= []).push(fn); return res; },
  };
  setImmediate(() => {
    cb(res);
    if (ctl.status < 300 || ctl.status >= 400) {
      setImmediate(() => listeners.end?.forEach((f) => f()));
    }
  });
  return { on: () => {}, end: (body?: unknown) => { ctl.body = body?.toString(); } };
};
jest.unstable_mockModule('https', () => ({ request: requestStub }));
jest.unstable_mockModule('http', () => ({ request: requestStub }));

const { createWebhookChannel, createEmailChannel, createChannelRegistry } =
  await import('../src/services/notification-channels.js');

const MESSAGE = {
  recipientOrgId: 'org-1',
  subject: 'subj',
  body: 'plain body',
  priority: 'normal' as const,
  messageType: 'announcement' as const,
  payload: { event: 'compliance.block', rule: 'r1' },
  dedupeKey: 'fp-1',
};

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  ctl.status = 200; ctl.options = null; ctl.body = undefined; ctl.calls = 0;
});

describe('createWebhookChannel', () => {
  const channel = createWebhookChannel();

  it('forwards msg.payload verbatim and reports the status', async () => {
    const result = await channel.deliver(MESSAGE, { value: 'https://hooks.example.com/x' });

    expect(result).toEqual({ ok: true, code: 200 });
    expect(ctl.body).toBe(JSON.stringify(MESSAGE.payload));
    expect(ctl.options?.method).toBe('POST');
  });

  it('PINS the vetted address into the socket and keeps Host/SNI (defeats rebinding)', async () => {
    await channel.deliver(MESSAGE, { value: 'https://hooks.example.com/x' });

    // Resolved exactly once, up front — the send must not re-resolve.
    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(ctl.options?.hostname).toBe('hooks.example.com');
    expect(ctl.options?.servername).toBe('hooks.example.com');

    const pinned = await new Promise<string>((resolve) => {
      ctl.options!.lookup('hooks.example.com', {}, (_e: unknown, addr: string) => resolve(addr));
    });
    expect(pinned).toBe('93.184.216.34');
    expect(mockLookup).toHaveBeenCalledTimes(1); // still once
  });

  it('signs with X-PB-Signature only when the target carries a secret', async () => {
    await channel.deliver(MESSAGE, { value: 'https://hooks.example.com/x' });
    expect(ctl.options?.headers).not.toHaveProperty('X-PB-Signature');

    await channel.deliver(MESSAGE, { value: 'https://hooks.example.com/x', secret: 's3cr3t' });
    const expected = `sha256=${createHmac('sha256', 's3cr3t').update(ctl.body as string).digest('hex')}`;
    expect(ctl.options?.headers['X-PB-Signature']).toBe(expected);
  });

  it('treats a 3xx as a refused redirect — a failed delivery, never a false green', async () => {
    ctl.status = 302;
    const result = await channel.deliver(MESSAGE, { value: 'https://hooks.example.com/x' });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(302);
    expect(result.error).toMatch(/redirected/);
    expect(ctl.calls).toBe(1); // never followed
  });

  it('reports a non-2xx with its status', async () => {
    ctl.status = 503;
    await expect(channel.deliver(MESSAGE, { value: 'https://hooks.example.com/x' }))
      .resolves.toEqual({ ok: false, code: 503 });
  });

  it('refuses a host that resolves to a private address, and never connects', async () => {
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const result = await channel.deliver(MESSAGE, { value: 'https://sneaky.example.com/x' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/private address/);
    expect(ctl.calls).toBe(0);
  });

  it('refuses a non-https target before resolving', async () => {
    const result = await channel.deliver(MESSAGE, { value: 'http://hooks.example.com/x' });

    expect(result.ok).toBe(false);
    expect(mockLookup).not.toHaveBeenCalled();
    expect(ctl.calls).toBe(0);
  });

  it('fails closed with no target url', async () => {
    await expect(channel.deliver(MESSAGE, {})).resolves.toEqual({ ok: false, error: 'no webhook url' });
    expect(ctl.calls).toBe(0);
  });

  it('honours a custom name + renderer (this is how Slack is built)', async () => {
    const slack = createWebhookChannel({ name: 'slack', render: (m) => ({ text: m.subject }) });
    expect(slack.channel).toBe('slack');

    await slack.deliver(MESSAGE, { value: 'https://hooks.slack.com/x' });
    expect(JSON.parse(ctl.body as string)).toEqual({ text: 'subj' });
  });
});

describe('createEmailChannel', () => {
  it('reports SKIPPED (not delivered) when email is disabled on the deploy', async () => {
    const send = jest.fn<() => Promise<boolean>>();
    const channel = createEmailChannel({ send, enabled: () => false });

    await expect(channel.deliver(MESSAGE, { value: 'ops@acme.com' }))
      .resolves.toEqual({ ok: false, skipped: true, error: 'email-disabled' });
    expect(send).not.toHaveBeenCalled();
  });

  it('passes the recipient, org, subject and body to the injected sender', async () => {
    const send = jest.fn<(...a: any[]) => Promise<boolean>>(async () => true);
    const channel = createEmailChannel({ send });

    await expect(channel.deliver(MESSAGE, { value: 'ops@acme.com', targetUsers: ['u1'] }))
      .resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith({
      to: 'ops@acme.com', orgId: 'org-1', targetUsers: ['u1'], subject: 'subj', text: 'plain body',
    });
  });

  it('dedupes a repeat of the same (dedupeKey, target) inside the window', async () => {
    const send = jest.fn<() => Promise<boolean>>(async () => true);
    const channel = createEmailChannel({ send, dedupeTtlMs: 60_000 });

    await expect(channel.deliver(MESSAGE, { value: 'ops@acme.com' })).resolves.toEqual({ ok: true });
    await expect(channel.deliver(MESSAGE, { value: 'ops@acme.com' })).resolves.toEqual({ ok: true, skipped: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does NOT record dedupe for a failed send, so the next attempt retries', async () => {
    const send = jest.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const channel = createEmailChannel({ send, dedupeTtlMs: 60_000 });

    await expect(channel.deliver(MESSAGE, { value: 'a@b.com' }))
      .resolves.toEqual({ ok: false, error: 'email-send-failed' });
    await expect(channel.deliver(MESSAGE, { value: 'a@b.com' })).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('surfaces a throwing sender as a failed delivery, never a throw', async () => {
    const channel = createEmailChannel({ send: async () => { throw new Error('smtp down'); } });
    const result = await channel.deliver(MESSAGE, { value: 'a@b.com' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/smtp down/);
  });
});

describe('createChannelRegistry', () => {
  it('resolves registered channels by name and yields null for an unknown one', () => {
    const registry = createChannelRegistry([
      createWebhookChannel(),
      createWebhookChannel({ name: 'slack' }),
    ]);
    expect(registry('webhook')?.channel).toBe('webhook');
    expect(registry('slack')?.channel).toBe('slack');
    // Channel names are DB data, so an unknown value must not throw.
    expect(registry('pagerduty')).toBeNull();
  });
});
