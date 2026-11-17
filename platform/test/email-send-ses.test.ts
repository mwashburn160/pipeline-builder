// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EmailService.send SESv2 path: provider selection (ses → nodemailer SES
 * transport), configuration-set inclusion (SES sends ride the deploy's config set
 * so bounces/complaints publish to SNS; omitted for SMTP / when unset), and the
 * failure contract (send rejects → returns false, never throws). Nodemailer, the
 * SESv2 client, api-core, and config are mocked; the module is reloaded per case
 * so the singleton re-initializes against that case's config.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendMail = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockCreateTransport = jest.fn((_opts: unknown) => ({ sendMail: mockSendMail }));

// Mutable config the mock factory reads on each (post-reset) import.
let mockConfig: any;

jest.unstable_mockModule('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));
const mockSesClientOpts: unknown[] = [];
const mockIncCounter = jest.fn();
jest.unstable_mockModule('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class { constructor(opts: unknown) { mockSesClientOpts.push(opts); } },
  SendEmailCommand: class { },
}));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));
jest.unstable_mockModule('../src/config/index.js', () => ({ get config() { return mockConfig; } }));

function sesConfig(overrides: { configurationSet?: string; provider?: string; enabled?: boolean; timeoutMs?: number } = {}) {
  return {
    email: {
      enabled: overrides.enabled ?? true,
      provider: overrides.provider ?? 'ses',
      ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
      from: 'noreply@pb.example',
      fromName: 'Pipeline Builder',
      ses: {
        region: 'us-east-1',
        accessKeyId: '',
        secretAccessKey: '',
        configurationSet: overrides.configurationSet ?? '',
      },
      smtp: { host: 'localhost', port: 25, secure: false, user: '', pass: '' },
    },
  };
}

async function loadEmailService(cfg: any) {
  mockConfig = cfg;
  jest.resetModules();
  mockSendMail.mockReset().mockResolvedValue({ messageId: 'msg-1' });
  mockCreateTransport.mockClear();
  mockIncCounter.mockClear();
  mockSesClientOpts.length = 0;
  const mod = await import('../src/utils/email.js');
  return mod.emailService;
}

describe('EmailService.send — SESv2 path', () => {
  it('initializes the nodemailer SES transport when provider=ses', async () => {
    const svc = await loadEmailService(sesConfig());
    const ok = await svc.send({ to: 'a@x.com', subject: 'S', text: 'T' });

    expect(ok).toBe(true);
    // The transport was built for SES (not SMTP host/port).
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    const arg = mockCreateTransport.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toHaveProperty('SES');
    expect(arg).not.toHaveProperty('host');
  });

  it('routes SES sends through the configuration set when one is configured', async () => {
    const svc = await loadEmailService(sesConfig({ configurationSet: 'pb-notifications' }));
    await svc.send({ to: 'a@x.com', subject: 'S', text: 'T' });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ ses: { ConfigurationSetName: 'pb-notifications' } }),
    );
  });

  it('omits the ses config-set field when none is configured', async () => {
    const svc = await loadEmailService(sesConfig({ configurationSet: '' }));
    await svc.send({ to: 'a@x.com', subject: 'S', text: 'T' });

    const arg = mockSendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('ses');
    // From/subject still assembled from config.
    expect(arg.from).toBe('"Pipeline Builder" <noreply@pb.example>');
  });

  it('returns false (does not throw) when the underlying send rejects', async () => {
    const svc = await loadEmailService(sesConfig({ configurationSet: 'pb-notifications' }));
    mockSendMail.mockRejectedValueOnce(new Error('SES throttled'));

    await expect(svc.send({ to: 'a@x.com', subject: 'S', text: 'T' })).resolves.toBe(false);
  });
});

describe('domain-join notifications — HTML escaping', () => {
  it('escapes the requester email + org name in the join-request-received HTML', async () => {
    const svc = await loadEmailService(sesConfig());
    await svc.sendJoinRequestReceived(['admin@bigcorp.com'], 'Big<b>Corp</b>', 'x"><svg/onload=alert(1)>@bigcorp.com');

    const arg = mockSendMail.mock.calls[0][0] as { html: string };
    // Raw markup from the attacker-controlled values must NOT appear verbatim.
    expect(arg.html).not.toContain('<svg/onload=alert(1)>');
    expect(arg.html).not.toContain('Big<b>Corp</b>');
    // The escaped forms are present instead.
    expect(arg.html).toContain('&lt;svg/onload=alert(1)&gt;');
    expect(arg.html).toContain('Big&lt;b&gt;Corp&lt;/b&gt;');
  });

  it('escapes the org name in the join-request-decision HTML', async () => {
    const svc = await loadEmailService(sesConfig());
    await svc.sendJoinRequestDecision('user@x.com', 'Evil<img src=x onerror=alert(1)>', true);

    const arg = mockSendMail.mock.calls[0][0] as { html: string };
    expect(arg.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(arg.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('sendEmailChanged — the notice to the PREVIOUS address', () => {
  it('goes to the old address, names the new one, and escapes both in the HTML', async () => {
    const svc = await loadEmailService(sesConfig());
    await svc.sendEmailChanged('owner@example.com', 'x"><svg/onload=alert(1)>@evil.com');

    const arg = mockSendMail.mock.calls[0][0] as { to: string; subject: string; text: string; html: string };
    expect(arg.to).toBe('owner@example.com');
    expect(arg.subject).toContain('sign-in email was changed');
    expect(arg.text).toContain('owner@example.com');
    expect(arg.text).toContain('@evil.com');
    expect(arg.html).not.toContain('<svg/onload=alert(1)>');
    expect(arg.html).toContain('&lt;svg/onload=alert(1)&gt;');
  });
});

describe('send timeouts — a stalled mail server fails the send in seconds', () => {
  it('bounds the SES client connect + request with config.email.timeoutMs', async () => {
    const svc = await loadEmailService(sesConfig({ timeoutMs: 7_000 }));
    await svc.send({ to: 'a@x.com', subject: 'S', text: 'T' });
    expect(mockSesClientOpts[0]).toMatchObject({ requestHandler: { connectionTimeout: 7_000, requestTimeout: 7_000 } });
  });

  it('bounds every SMTP phase, defaulting to 10s when config carries none', async () => {
    const svc = await loadEmailService(sesConfig({ provider: 'smtp' }));
    await svc.send({ to: 'a@x.com', subject: 'S', text: 'T' });
    expect(mockCreateTransport.mock.calls[0][0]).toMatchObject({
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    });
  });
});

describe('platform_email_send_total{transport,outcome}', () => {
  it('counts a success under its transport', async () => {
    const svc = await loadEmailService(sesConfig());
    await svc.send({ to: 'a@x.com', subject: 'S', text: 'T' });
    expect(mockIncCounter).toHaveBeenCalledWith('platform_email_send_total', { transport: 'ses', outcome: 'success' });
  });

  it('counts a failure — and still returns false', async () => {
    const svc = await loadEmailService(sesConfig({ provider: 'smtp' }));
    mockSendMail.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    await expect(svc.send({ to: 'a@x.com', subject: 'S', text: 'T' })).resolves.toBe(false);
    expect(mockIncCounter).toHaveBeenCalledWith('platform_email_send_total', { transport: 'smtp', outcome: 'failure' });
  });

  it('counts a disabled-mail skip, and a metrics outage never fails the send', async () => {
    const svc = await loadEmailService(sesConfig({ enabled: false }));
    mockIncCounter.mockImplementationOnce(() => { throw new Error('no registry'); });
    await expect(svc.send({ to: 'a@x.com', subject: 'S', text: 'T' })).resolves.toBe(true);
    expect(mockIncCounter).toHaveBeenCalledWith('platform_email_send_total', { transport: 'disabled', outcome: 'skipped' });
  });

  it('counts a failure when the transporter never initialized', async () => {
    mockCreateTransport.mockImplementationOnce(() => { throw new Error('bad config'); });
    const svc = await loadEmailService(sesConfig());
    await expect(svc.send({ to: 'a@x.com', subject: 'S', text: 'T' })).resolves.toBe(false);
    expect(mockIncCounter).toHaveBeenCalledWith('platform_email_send_total', { transport: 'ses', outcome: 'failure' });
  });
});
