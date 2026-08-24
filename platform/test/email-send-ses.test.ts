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

const mockSendMail = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));

// Mutable config the mock factory reads on each (post-reset) import.
let mockConfig: any;

jest.unstable_mockModule('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));
jest.unstable_mockModule('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class { },
  SendEmailCommand: class { },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));
jest.unstable_mockModule('../src/config/index.js', () => ({ get config() { return mockConfig; } }));

function sesConfig(overrides: { configurationSet?: string } = {}) {
  return {
    email: {
      enabled: true,
      provider: 'ses',
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
