// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-transport notification channels (services/notification-channels).
 *
 * The webhook + slack + email TRANSPORTS are api-core's shared factories now,
 * and their behaviour — pin the vetted IP, refuse redirects, HMAC, caps, the
 * skipped/dedupe semantics — is asserted against the real code in
 * `packages/api-core/test/notification-channels.test.ts`. The factories are
 * stubbed here with recording transports so this suite can assert what belongs
 * to PLATFORM: the alert→message mapping (severity → subject/priority/body),
 * the Slack renderer, and the `in-app` transport that writes the shared
 * `messages` table directly.
 *
 * pipeline-core (schema + withTenantTx), the email service and the platform
 * config are mocked so the channels load without a DB / SMTP / SES chain.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

// -- mocks --------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

// Recording stand-ins for the shared transports, plus the options each factory
// was configured with (that is how the Slack renderer is reached).
const webhookOpts: Record<string, any>[] = [];
const emailOpts: Record<string, any>[] = [];
const sent: { channel: string; msg: any; target: any }[] = [];
const results: Record<string, any> = { webhook: { ok: true, code: 200 }, slack: { ok: true, code: 200 } };
const recordingChannel = (name: string) => ({
  channel: name,
  deliver: async (msg: any, target: any) => {
    sent.push({ channel: name, msg, target });
    return results[name];
  },
});

const insertedRows: Array<Record<string, unknown>> = [];
const mockValues = jest.fn((row: Record<string, unknown>) => { insertedRows.push(row); return Promise.resolve(); });
const mockInsert = jest.fn(() => ({ values: mockValues }));
const mockWithTenantTx = jest.fn(async (fn: (tx: unknown) => unknown) => fn({ insert: mockInsert }));

const mockSend = jest.fn<(opts: { to: string; subject: string; text?: string }) => Promise<boolean>>(async () => true);
const cfg = { email: { enabled: true }, observability: { alertEmailDedupeTtlMs: 600_000 } };

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createWebhookChannel: (opts: Record<string, any> = {}) => {
    webhookOpts.push(opts);
    return recordingChannel(opts.name ?? 'webhook');
  },
  createEmailChannel: (opts: Record<string, any>) => {
    emailOpts.push(opts);
    return {
      channel: 'email',
      deliver: async (msg: any, target: any) => {
        if (opts.enabled && !opts.enabled()) return { ok: false, skipped: true, error: 'email-disabled' };
        const ok = await opts.send({
          to: target.value,
          orgId: msg.recipientOrgId,
          targetUsers: target.targetUsers ?? null,
          subject: msg.subject,
          text: msg.body,
        });
        return ok ? { ok: true } : { ok: false, error: 'email-send-failed' };
      },
    };
  },
  createChannelRegistry: (channels: { channel: string }[]) => {
    const byName = new Map(channels.map((c) => [c.channel, c]));
    return (name: string) => byName.get(name) ?? null;
  },
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: { message: { __table: 'messages' } },
  withTenantTx: (fn: (tx: unknown) => unknown) => mockWithTenantTx(fn),
}));
jest.unstable_mockModule('../src/utils/email.js', () => ({
  emailService: { send: mockSend },
  default: { send: mockSend },
}));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig(cfg));

const { getNotificationChannel, plainTextBody, severityToPriority, subjectLine } =
  await import('../src/services/notification-channels.js');
import type { AlertNotification, ChannelTarget } from '../src/services/notification-channels.js';

// -- fixtures -----------------------------------------------------------------

const ALERT = {
  severity: 'critical' as const,
  status: 'firing' as const,
  timestamp: '2026-06-17T00:00:00Z',
  title: 'HighErrorRate',
  summary: 'Error rate is high',
  detail: 'Above 5% for 10m',
  labels: { alertname: 'HighErrorRate', severity: 'critical', org_id: 'o1', region: 'us-east-1' },
};

const baseMsg = (over: Partial<AlertNotification> = {}): AlertNotification => ({
  ...ALERT,
  recipientOrgId: 'o1',
  subject: subjectLine(ALERT),
  body: plainTextBody(ALERT),
  priority: severityToPriority(ALERT.severity),
  messageType: 'announcement',
  payload: { kind: 'raw-alert', fingerprint: 'fp-1' },
  dedupeKey: 'fp-1',
  ...over,
});
const target = (over: Partial<ChannelTarget> = {}): ChannelTarget => ({ value: 'https://x', orgId: 'o1', ...over });
const signal = () => new AbortController().signal;

beforeEach(() => {
  insertedRows.length = 0;
  mockSend.mockClear();
  cfg.email.enabled = true;
  sent.length = 0;
  results.webhook = { ok: true, code: 200 };
  results.slack = { ok: true, code: 200 };
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
  it('is the SHARED webhook transport with a Slack renderer (not a bespoke fetch)', () => {
    // The old bespoke sender ran NO SSRF guard at all. Building Slack from the
    // shared factory is what closed that hole, so assert it is built that way.
    const slack = webhookOpts.find((o) => o.name === 'slack');
    expect(slack).toBeDefined();
    expect(typeof slack!.render).toBe('function');
  });

  it('renders a severity-coloured attachment payload', () => {
    const slack = webhookOpts.find((o) => o.name === 'slack')!;
    const body = slack.render(baseMsg()) as any;

    expect(body.attachments[0].title).toContain('[CRITICAL] HighErrorRate');
    expect(body.attachments[0].color).toBe('#dc2626');
    expect(body.attachments[0].text).toBe('Error rate is high');
    // Noise labels are filtered out of the field list.
    const fieldTitles = body.attachments[0].fields.map((f: any) => f.title);
    expect(fieldTitles).toContain('region');
    expect(fieldTitles).not.toContain('alertname');
  });

  it('uses a resolved emoji + colour for a resolved warning', () => {
    const slack = webhookOpts.find((o) => o.name === 'slack')!;
    const body = slack.render(baseMsg({ severity: 'warning', status: 'resolved' })) as any;
    expect(body.attachments[0].color).toBe('#eab308');
    expect(body.attachments[0].title).toContain('✅');
  });

  it('relays the transport outcome unchanged', async () => {
    results.slack = { ok: false, code: 500 };
    const res = await getNotificationChannel('slack')!.deliver(baseMsg(), target(), signal());
    expect(res).toEqual({ ok: false, code: 500 });
  });
});

// -- webhook ------------------------------------------------------------------

describe('webhook channel', () => {
  it('is the SHARED generic transport — no custom name or renderer', () => {
    const generic = webhookOpts.find((o) => o.name === undefined);
    expect(generic).toBeDefined();
    // No renderer ⇒ `msg.payload` (the raw Alertmanager body) is forwarded
    // verbatim, so existing webhook consumers keep the shape they expect.
    expect(generic!.render).toBeUndefined();
  });

  it('hands the destination target straight to the shared transport', async () => {
    const msg = baseMsg();
    await getNotificationChannel('webhook')!.deliver(msg, target({ value: 'https://hooks.example.com/x', secret: 's3cr3t' }), signal());

    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe('webhook');
    expect(sent[0].target).toMatchObject({ value: 'https://hooks.example.com/x', secret: 's3cr3t' });
    expect(sent[0].msg.payload).toEqual(msg.payload);
  });

  it('relays a refused redirect as a failed delivery', async () => {
    results.webhook = { ok: false, code: 302, error: 'webhook url redirected (refused)' };
    const res = await getNotificationChannel('webhook')!.deliver(baseMsg(), target(), signal());
    expect(res.ok).toBe(false);
    expect(res.code).toBe(302);
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
      orgId: '000000000000000000000001',
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
  it('configures the shared transport with the deploy switch and the dedupe window', () => {
    // The dedupe/skipped SEMANTICS are api-core's (asserted there). Platform's
    // job is to supply the deploy's email switch and the alert dedupe TTL —
    // Alertmanager retries its webhook, so an identical (alert, recipient)
    // inside the window must not be re-mailed.
    expect(emailOpts).toHaveLength(1);
    expect(emailOpts[0].dedupeTtlMs).toBe(600_000);
    expect(typeof emailOpts[0].enabled).toBe('function');
    expect(emailOpts[0].enabled()).toBe(true);
    cfg.email.enabled = false;
    expect(emailOpts[0].enabled()).toBe(false);
  });

  it('sends the rendered subject + body to the target address via EmailService', async () => {
    const res = await getNotificationChannel('email')!.deliver(
      baseMsg(), target({ value: 'ops@acme.com' }), signal());

    expect(res).toEqual({ ok: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0][0];
    expect(arg.to).toBe('ops@acme.com');
    expect(arg.subject).toBe('[CRITICAL] HighErrorRate');
    // Body carries summary + detail + non-noise labels + status footer.
    expect(arg.text).toContain('Error rate is high');
    expect(arg.text).toContain('region=us-east-1');
    expect(arg.text).toContain('Status: firing');
  });

  it('reports skipped without sending when email is disabled on the deploy', async () => {
    cfg.email.enabled = false;
    const res = await getNotificationChannel('email')!.deliver(
      baseMsg(), target({ value: 'a@b.com' }), signal());

    expect(res).toEqual({ ok: false, skipped: true, error: 'email-disabled' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('reports failed when EmailService cannot send', async () => {
    mockSend.mockResolvedValueOnce(false);
    const res = await getNotificationChannel('email')!.deliver(
      baseMsg(), target({ value: 'c@d.com' }), signal());

    expect(res).toEqual({ ok: false, error: 'email-send-failed' });
  });
});
