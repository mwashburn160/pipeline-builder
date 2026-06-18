// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-transport notification channels (services/notification-channels).
 *
 * pipeline-core (schema + withTenantTx), the email service, and the platform
 * config are mocked so the channels load without a DB / SMTP / SES chain;
 * `fetch` is stubbed for the HTTP channels. api-core is the shared real-ish mock.
 */

import { createHmac } from 'crypto';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// -- mocks --------------------------------------------------------------------

const insertedRows: Array<Record<string, unknown>> = [];
const mockValues = jest.fn((row: Record<string, unknown>) => { insertedRows.push(row); return Promise.resolve(); });
const mockInsert = jest.fn(() => ({ values: mockValues }));
const mockWithTenantTx = jest.fn(async (fn: (tx: unknown) => unknown) => fn({ insert: mockInsert }));

const mockSend = jest.fn<(opts: { to: string; subject: string; text?: string }) => Promise<boolean>>(async () => true);
const mockConfig = { email: { enabled: true } };

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  schema: { message: { __table: 'messages' } },
  withTenantTx: (fn: (tx: unknown) => unknown) => mockWithTenantTx(fn),
}));
jest.unstable_mockModule('../src/utils/email.js', () => ({
  emailService: { send: mockSend },
  default: { send: mockSend },
}));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: mockConfig }));

const { getNotificationChannel } = await import('../src/services/notification-channels.js');
import type { NotificationMessage, ChannelTarget } from '../src/services/notification-channels.js';

// -- fixtures -----------------------------------------------------------------

const baseMsg = (over: Partial<NotificationMessage> = {}): NotificationMessage => ({
  severity: 'critical',
  status: 'firing',
  timestamp: '2026-06-17T00:00:00Z',
  title: 'HighErrorRate',
  summary: 'Error rate is high',
  detail: 'Above 5% for 10m',
  labels: { alertname: 'HighErrorRate', severity: 'critical', org_id: 'o1', region: 'us-east-1' },
  recipientOrgId: 'o1',
  raw: { kind: 'raw-alert', fingerprint: 'fp-1' },
  dedupeKey: 'fp-1',
  ...over,
});
const target = (over: Partial<ChannelTarget> = {}): ChannelTarget => ({ value: 'https://x', orgId: 'o1', ...over });
const signal = () => new AbortController().signal;

const fetchMock = jest.fn<typeof fetch>();
beforeEach(() => {
  insertedRows.length = 0;
  mockSend.mockClear();
  mockConfig.email.enabled = true;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { jest.restoreAllMocks(); });

// -- factory ------------------------------------------------------------------

describe('getNotificationChannel', () => {
  it('maps each known channel and returns null for unknown', () => {
    for (const c of ['slack', 'webhook', 'in-app', 'email']) {
      expect(getNotificationChannel(c)?.channel).toBe(c);
    }
    expect(getNotificationChannel('pagerduty')).toBeNull();
  });
});

// -- slack --------------------------------------------------------------------

describe('slack channel', () => {
  it('POSTs a slack attachment payload and reports ok on 2xx', async () => {
    const res = await getNotificationChannel('slack')!.deliver(baseMsg(), target({ value: 'https://hooks.slack.com/x' }), signal());
    expect(res).toEqual({ ok: true, code: 200 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/x');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.attachments[0].title).toContain('[CRITICAL] HighErrorRate');
    expect(body.attachments[0].color).toBe('#dc2626');
  });

  it('reports failed (with code) on non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    const res = await getNotificationChannel('slack')!.deliver(baseMsg(), target(), signal());
    expect(res).toEqual({ ok: false, code: 500 });
  });
});

// -- webhook ------------------------------------------------------------------

describe('webhook channel', () => {
  it('forwards msg.raw unchanged and is unsigned without a secret', async () => {
    const msg = baseMsg();
    await getNotificationChannel('webhook')!.deliver(msg, target(), signal());
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(JSON.stringify(msg.raw));
    expect((init.headers as Record<string, string>)['X-PB-Signature']).toBeUndefined();
  });

  it('HMAC-signs the body when a secret is present', async () => {
    const msg = baseMsg();
    await getNotificationChannel('webhook')!.deliver(msg, target({ secret: 's3cr3t' }), signal());
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const expected = `sha256=${createHmac('sha256', 's3cr3t').update(init.body as string).digest('hex')}`;
    expect((init.headers as Record<string, string>)['X-PB-Signature']).toBe(expected);
  });
});

// -- in-app -------------------------------------------------------------------

describe('in-app channel', () => {
  it('inserts a system-authored message row with mapped subject/priority/content', async () => {
    const res = await getNotificationChannel('in-app')!.deliver(baseMsg(), target(), signal());
    expect(res).toEqual({ ok: true });
    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0];
    expect(row).toMatchObject({
      orgId: 'system',
      recipientOrgId: 'o1',
      messageType: 'announcement',
      subject: '[CRITICAL] HighErrorRate',
      priority: 'urgent',
    });
    // content carries summary + detail + non-noise labels + status footer
    expect(String(row.content)).toContain('Error rate is high');
    expect(String(row.content)).toContain('region=us-east-1');
    expect(String(row.content)).toContain('Status: firing');
    expect(String(row.content)).not.toContain('org_id='); // filtered noise label
  });

  it('reports failed (not thrown) when the insert rejects', async () => {
    mockValues.mockRejectedValueOnce(new Error('db down'));
    const res = await getNotificationChannel('in-app')!.deliver(baseMsg(), target(), signal());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('db down');
  });
});

// -- email --------------------------------------------------------------------

describe('email channel', () => {
  it('sends to the address and dedupes a retried (alert, recipient) within the window', async () => {
    const msg = baseMsg({ dedupeKey: 'fp-dedupe' });
    const tgt = target({ value: 'ops@acme.com' });
    const first = await getNotificationChannel('email')!.deliver(msg, tgt, signal());
    expect(first).toEqual({ ok: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@acme.com', subject: '[CRITICAL] HighErrorRate' }));

    const second = await getNotificationChannel('email')!.deliver(msg, tgt, signal());
    expect(second).toEqual({ ok: true, skipped: true });
    expect(mockSend).toHaveBeenCalledTimes(1); // not re-sent
  });

  it('reports skipped without sending when email is disabled', async () => {
    mockConfig.email.enabled = false;
    const res = await getNotificationChannel('email')!.deliver(baseMsg({ dedupeKey: 'fp-disabled' }), target({ value: 'a@b.com' }), signal());
    expect(res).toEqual({ ok: false, skipped: true, error: 'email-disabled' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('reports failed (and does not record dedupe) when the send fails', async () => {
    mockSend.mockResolvedValueOnce(false);
    const msg = baseMsg({ dedupeKey: 'fp-fail' });
    const tgt = target({ value: 'c@d.com' });
    const first = await getNotificationChannel('email')!.deliver(msg, tgt, signal());
    expect(first).toEqual({ ok: false, error: 'email-send-failed' });
    // a failed send is NOT deduped — the next webhook retry sends again
    const second = await getNotificationChannel('email')!.deliver(msg, tgt, signal());
    expect(second).toEqual({ ok: true });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
