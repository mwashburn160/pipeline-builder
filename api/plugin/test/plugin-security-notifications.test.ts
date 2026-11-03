// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org plugin security notifications (services/plugin-security-notifications):
 * settings validation and storage (secret + address encrypted, never returned),
 * the external address's confirmation (single use, 24 h, used ONLY once
 * confirmed), recipient rules per mode, N30 (blocked version) and N31 (rescan
 * findings: dedupe per version + CVE, digest mode, opt-out), the webhook and
 * the test send. The database is the in-memory fake; the relay and the webhook
 * transport are spies.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import { setupEcosystemHarness } from './helpers/ecosystem-harness.js';

process.env.SECRET_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.PLATFORM_FRONTEND_URL = 'https://pb.example.com';

const h = setupEcosystemHarness();
const svc = await import('../src/services/plugin-security-notifications.js');
const { EcosystemError } = await import('../src/services/ecosystem/context.js');

const ORG = 'org-a';
const webhook = jest.fn<(url: string, secret: string | undefined, payload: any) => Promise<{ ok: boolean; code?: number }>>();
const seen = new Map<string, Set<string>>();
const dedupe = {
  claimNew: jest.fn(async (key: string, members: readonly string[]) => {
    const set = seen.get(key) ?? new Set<string>();
    seen.set(key, set);
    const fresh = members.filter((m) => !set.has(m));
    fresh.forEach((m) => set.add(m));
    return fresh;
  }),
};

const row = () => (h.db.tables.plugin_security_notification_prefs ?? []).find((r) => r.orgId === ORG);
const finding = (id: string, fixedIn: string[] = ['3.0.2'], severity: 'critical' | 'high' = 'critical') =>
  ({ id, severity, packageName: 'openssl', packageVersion: '3.0.1', fixedIn });
/** The token in the last confirmation email the relay was asked to send. */
function lastConfirmToken(): string {
  const call = [...h.notify.mock.calls].reverse().find((c: any[]) => (c[2] as { subject: string }).subject.startsWith('Confirm this address'));
  const m = /token=([A-Za-z0-9_-]+)/.exec((call![2] as { text: string }).text);
  return decodeURIComponent(m![1]!);
}

beforeEach(() => {
  jest.clearAllMocks();
  h.db.reset();
  seen.clear();
  webhook.mockResolvedValue({ ok: true, code: 200 });
  svc.setSecurityWebhookSenderForTests(webhook);
  svc.setNoticeDedupeStoreForTests(dedupe);
});

describe('settings', () => {
  it('an org with no row reads the defaults', async () => {
    await expect(svc.getSecurityPrefs(ORG, false)).resolves.toEqual({
      recipientMode: 'writers',
      targetUsers: [],
      notifyRescan: true,
      notifyPipelineOwners: true,
      digestMode: 'immediate',
      webhookUrl: null,
      hasWebhookSecret: false,
      externalEmail: null,
      updatedBy: null,
      updatedAt: null,
      canEdit: false,
    });
  });

  it.each([
    [{ nope: 1 }, /unknown field/],
    [{ recipientMode: 'everyone' }, /recipientMode/],
    [{ recipientMode: 'users' }, /at least one user/],
    [{ recipientMode: 'users', targetUsers: [] }, /at least one user/],
    [{ targetUsers: 'u1' }, /targetUsers/],
    [{ targetUsers: Array.from({ length: 101 }, (_, i) => `u${i}`) }, /at most 100/],
    [{ digestMode: 'hourly' }, /digestMode/],
    [{ notifyRescan: 'yes' }, /notifyRescan/],
    [{ webhookUrl: 'http://hooks.example.com/x' }, /https/],
    [{ webhookUrl: 'https://10.0.0.5/x' }, /not allowed/],
    [{ webhookSecret: 5 }, /webhookSecret/],
    [{ externalEmail: 'not-an-email' }, /externalEmail/],
    [{ resendConfirmation: 'y' }, /resendConfirmation/],
    [[], /object/],
  ])('refuses %j (400)', async (body, message) => {
    const err = await svc.putSecurityPrefs(ORG, 'u-admin', body).catch((e) => e);
    expect(err).toBeInstanceOf(EcosystemError);
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(err.message).toMatch(message);
    expect(row()).toBeUndefined();
  });

  it('stores the webhook secret ENCRYPTED, never returns it, and audits field names + host only', async () => {
    const out = await svc.putSecurityPrefs(ORG, 'u-admin', {
      recipientMode: 'users',
      targetUsers: ['u1', 'u1', 'u2'],
      digestMode: 'daily',
      notifyRescan: false,
      webhookUrl: 'https://93.184.216.34/hooks/pb?key=abc',
      webhookSecret: 's3cr3t',
    });
    expect(out).toMatchObject({
      recipientMode: 'users',
      targetUsers: ['u1', 'u2'],
      digestMode: 'daily',
      notifyRescan: false,
      webhookUrl: 'https://93.184.216.34/hooks/pb?key=abc',
      hasWebhookSecret: true,
      canEdit: true,
      updatedBy: 'u-admin',
    });
    expect(JSON.stringify(out)).not.toContain('s3cr3t');
    expect(row()!.webhookSecret).not.toContain('s3cr3t');
    expect(JSON.parse(row()!.webhookSecret)).toMatchObject({ alg: 'aes-256-gcm-v1' });
    const audit = h.audit.mock.calls.map((c: any[]) => c[0]).find((e: any) => e.action === 'plugin.security_notifications.update');
    expect(audit).toMatchObject({ orgId: ORG, targetId: ORG, details: expect.objectContaining({ webhookHost: '93.184.216.34', webhookSecretSet: true }) });
    expect(JSON.stringify(audit)).not.toContain('s3cr3t');
    expect(JSON.stringify(audit)).not.toContain('key=abc');
  });

  // Design rule 6: the Ask panel commits a notification-preference proposal
  // through this service with the user's own session, so the audit event must
  // say an AI drafted it — and a client must not be able to say anything else.
  describe('ask-agent provenance', () => {
    const HEADER = 'x-pb-proposed-by';
    const updateAudit = () => h.audit.mock.calls.map((c: any[]) => c[0])
      .find((e: any) => e.action === 'plugin.security_notifications.update');

    it('records proposedBy when the request carried the marker', async () => {
      await svc.putSecurityPrefs(ORG, 'u', { digestMode: 'weekly' }, { [HEADER]: 'ask-agent' });
      expect(updateAudit().details).toMatchObject({ proposedBy: 'ask-agent', digestMode: 'weekly' });
    });

    it('records NO proposer for an ordinary admin save', async () => {
      await svc.putSecurityPrefs(ORG, 'u', { digestMode: 'weekly' });
      expect(updateAudit().details).not.toHaveProperty('proposedBy');
    });

    it('does NOT store a forged proposer', async () => {
      await svc.putSecurityPrefs(ORG, 'u', { digestMode: 'weekly' }, { [HEADER]: 'u-admin' });
      expect(updateAudit().details).not.toHaveProperty('proposedBy');
    });

    it('cannot displace what the service put in details', async () => {
      await svc.putSecurityPrefs(ORG, 'u', { notifyRescan: false }, { [HEADER]: 'ask-agent' });
      expect(updateAudit().details).toMatchObject({
        fields: ['notifyRescan'], notifyRescan: false, webhookSecretSet: false, proposedBy: 'ask-agent',
      });
    });
  });

  it('clearing the webhook URL drops its secret; an omitted secret is kept', async () => {
    await svc.putSecurityPrefs(ORG, 'u', { webhookUrl: 'https://93.184.216.34/h', webhookSecret: 'x' });
    await svc.putSecurityPrefs(ORG, 'u', { digestMode: 'weekly' });
    expect((await svc.getSecurityPrefs(ORG, true)).hasWebhookSecret).toBe(true);
    await svc.putSecurityPrefs(ORG, 'u', { webhookUrl: '' });
    expect(await svc.getSecurityPrefs(ORG, true)).toMatchObject({ webhookUrl: null, hasWebhookSecret: false });
  });
});

describe('external address confirmation', () => {
  it('REGRESSION: a new address gets a single-use link and receives NOTHING until confirmed', async () => {
    const out = await svc.putSecurityPrefs(ORG, 'u-admin', { externalEmail: 'Sec@Example.com' });
    expect(out.externalEmail).toEqual({ masked: 's***@example.com', verified: false, pendingExpiresAt: expect.any(String) });
    expect(row()!.externalEmailEnc).not.toContain('sec@example.com');
    // The link goes to the address itself, through the relay's N30 address recipient.
    expect(h.notify).toHaveBeenCalledWith('N30', [{ kind: 'address', email: 'sec@example.com' }],
      expect.objectContaining({ text: expect.stringContaining('https://pb.example.com/notifications/confirm?token=') }), { immediate: true });
    const token = lastConfirmToken();
    expect(row()!.externalVerifyTokenHash).not.toBe(token);

    // Unconfirmed: a blocked-version notice does not reach it.
    await svc.notifyVersionBlocked({ orgId: ORG, plugin: 'lint', version: '1.0.0', code: 'IMAGE_SCAN_UNAVAILABLE', message: 'x' });
    const n30 = h.notify.mock.calls.filter((c: any[]) => (c[2] as { subject: string }).subject.startsWith('Plugin version blocked'));
    expect(n30[0]![1]).not.toContainEqual(expect.objectContaining({ kind: 'address' }));

    await expect(svc.confirmExternalEmail(token)).resolves.toEqual({ confirmed: true });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.security_notifications.external_email.verify', orgId: ORG, actorId: 'anonymous' }));
    expect((await svc.getSecurityPrefs(ORG, true)).externalEmail).toEqual({ masked: 's***@example.com', verified: true, pendingExpiresAt: null });
    // Single use.
    await expect(svc.confirmExternalEmail(token)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // Confirmed: it now receives the notices.
    h.notify.mockClear();
    await svc.notifyVersionBlocked({ orgId: ORG, plugin: 'lint', version: '1.0.0', code: 'IMAGE_SCAN_UNAVAILABLE', message: 'x' });
    expect(h.notify.mock.calls[0]![1]).toContainEqual({ kind: 'address', email: 'sec@example.com' });
  });

  it('an expired, unknown or malformed token is refused', async () => {
    await svc.putSecurityPrefs(ORG, 'u', { externalEmail: 'sec@example.com' });
    const token = lastConfirmToken();
    row()!.externalVerifyExpiresAt = new Date(Date.now() - 1000);
    await expect(svc.confirmExternalEmail(token)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.confirmExternalEmail('x'.repeat(43))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.confirmExternalEmail(undefined)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(row()!.externalEmailVerifiedAt).toBeNull();
  });

  it('changing the address resets verification; the same address is a no-op; resend re-issues the link', async () => {
    await svc.putSecurityPrefs(ORG, 'u', { externalEmail: 'sec@example.com' });
    await svc.confirmExternalEmail(lastConfirmToken());
    h.notify.mockClear();
    await svc.putSecurityPrefs(ORG, 'u', { externalEmail: 'SEC@example.com' });
    expect(h.notify).not.toHaveBeenCalled();
    expect(row()!.externalEmailVerifiedAt).toBeInstanceOf(Date);

    await svc.putSecurityPrefs(ORG, 'u', { externalEmail: 'other@example.com' });
    expect(row()!.externalEmailVerifiedAt).toBeNull();
    const first = lastConfirmToken();
    await svc.putSecurityPrefs(ORG, 'u', { resendConfirmation: true });
    const second = lastConfirmToken();
    expect(second).not.toBe(first);
    await expect(svc.confirmExternalEmail(first)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.confirmExternalEmail(second)).resolves.toEqual({ confirmed: true });

    await svc.putSecurityPrefs(ORG, 'u', { externalEmail: null });
    expect((await svc.getSecurityPrefs(ORG, true)).externalEmail).toBeNull();
  });
});

describe('recipients', () => {
  it('writers mode: members holding plugins:write + the uploader (while a member)', async () => {
    const prefs = svc.defaultPrefs(ORG);
    await expect(svc.recipientsFor(prefs, 'u-up')).resolves.toEqual([
      { kind: 'org_permission', orgId: ORG, permission: 'plugins:write' },
      { kind: 'org_members', orgId: ORG, userIds: ['u-up'] },
    ]);
    await expect(svc.recipientsFor(prefs, 'system')).resolves.toEqual([{ kind: 'org_permission', orgId: ORG, permission: 'plugins:write' }]);
  });

  it('users mode: only the chosen members', async () => {
    await expect(svc.recipientsFor({ ...svc.defaultPrefs(ORG), recipientMode: 'users', targetUsers: ['u1', 'u2'] }, 'u-up'))
      .resolves.toEqual([{ kind: 'org_members', orgId: ORG, userIds: ['u1', 'u2'] }]);
  });
});

describe('N30 — blocked version', () => {
  it('goes immediately to the recipients and the webhook (signed with the decrypted secret), with the CVEs and fixes', async () => {
    await svc.putSecurityPrefs(ORG, 'u', { webhookUrl: 'https://93.184.216.34/h', webhookSecret: 'hmac-key', digestMode: 'weekly' });
    await svc.notifyVersionBlocked({
      orgId: ORG,
      uploaderId: 'u-up',
      plugin: 'lint',
      version: '2.0.0',
      code: 'PLUGIN_VULN_GATE',
      message: 'PLUGIN_VULN_GATE: the image has 1 fixable Critical finding',
      gated: 1,
      high: 0,
      findings: [finding('CVE-2026-1')],
    });
    expect(h.notify).toHaveBeenCalledWith('N30', expect.arrayContaining([{ kind: 'org_members', orgId: ORG, userIds: ['u-up'] }]),
      { subject: 'Plugin version blocked: lint@2.0.0', text: expect.stringContaining('CVE-2026-1 (openssl@3.0.1 → 3.0.2)') },
      { immediate: true });
    expect(webhook).toHaveBeenCalledWith('https://93.184.216.34/h', 'hmac-key', expect.objectContaining({
      event: 'N30', type: 'plugin.version.blocked', orgId: ORG, plugin: 'lint', version: '2.0.0', code: 'PLUGIN_VULN_GATE', gated: 1,
    }));
  });

  it('never throws: a failing relay or webhook is logged and counted', async () => {
    await svc.putSecurityPrefs(ORG, 'u', { webhookUrl: 'https://93.184.216.34/h' });
    h.notify.mockRejectedValueOnce(new Error('relay down'));
    webhook.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(svc.notifyVersionBlocked({ orgId: ORG, plugin: 'lint', version: '1.0.0', code: 'IMAGE_SCAN_UNAVAILABLE', message: 'x' })).resolves.toBeUndefined();
    h.db.failNextSelect('plugin_security_notification_prefs', new Error('db down'));
    await expect(svc.notifyVersionBlocked({ orgId: ORG, plugin: 'lint', version: '1.0.0', code: 'IMAGE_SCAN_UNAVAILABLE', message: 'x' })).resolves.toBeUndefined();
  });
});

describe('N31 — rescan findings', () => {
  const notice = (over: Record<string, unknown> = {}) => ({
    versionKey: 'plugin:p1',
    plugin: 'lint',
    version: '1.0.0',
    critical: 1,
    high: 1,
    flagged: true,
    findings: [finding('CVE-1'), finding('CVE-2', [], 'high')],
    orgs: [{ orgId: ORG, uploaderId: 'u-up' }],
    ...over,
  });

  it('REGRESSION: is deduplicated per (version, CVE) — the same findings never notify twice, a new CVE notifies alone', async () => {
    await expect(svc.notifyRescanFindings(notice())).resolves.toBe(1);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![2]).toMatchObject({ subject: 'Rescan found new Critical/High in plugin lint@1.0.0', text: expect.stringContaining('FLAGGED') });

    await expect(svc.notifyRescanFindings(notice())).resolves.toBe(0);
    expect(h.notify).toHaveBeenCalledTimes(1);

    await expect(svc.notifyRescanFindings(notice({ findings: [finding('CVE-1'), finding('CVE-3')] }))).resolves.toBe(1);
    const text = (h.notify.mock.calls[1]![2] as { text: string }).text;
    expect(text).toContain('CVE-3');
    expect(text).not.toContain('CVE-1 ');
    // Another version with the same CVE is its own key.
    await expect(svc.notifyRescanFindings(notice({ versionKey: 'plugin:p2' }))).resolves.toBe(1);
  });

  it('fails OPEN when the dedupe store is down (a duplicate beats a lost notice)', async () => {
    dedupe.claimNew.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.notifyRescanFindings(notice())).resolves.toBe(1);
  });

  it('honors each org\'s notifyRescan and digestMode; the webhook goes out at once', async () => {
    h.db.seed('plugin_security_notification_prefs', { orgId: 'org-daily', digestMode: 'daily' });
    h.db.seed('plugin_security_notification_prefs', { orgId: 'org-off', notifyRescan: false });
    h.db.seed('plugin_security_notification_prefs', { orgId: 'org-hook', webhookUrl: 'https://93.184.216.34/h' });
    await expect(svc.notifyRescanFindings(notice({ orgs: [{ orgId: 'org-daily' }, { orgId: 'org-off' }, { orgId: 'org-hook' }] }))).resolves.toBe(2);
    const byOrg = new Map(h.notify.mock.calls.map((c: any[]) => [c[1][0].orgId, c[3]]));
    expect(byOrg.get('org-daily')).toEqual({ deliverAfter: expect.any(Date), digestKey: 'N31:org-daily' });
    expect(byOrg.get('org-hook')).toEqual({ immediate: true });
    expect(byOrg.has('org-off')).toBe(false);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect(webhook.mock.calls[0]![2]).toMatchObject({ event: 'N31', type: 'plugin.rescan.findings', orgId: 'org-hook', critical: 1, high: 1 });
  });

  it('nothing to say → nothing sent', async () => {
    await expect(svc.notifyRescanFindings(notice({ findings: [] }))).resolves.toBe(0);
    await expect(svc.notifyRescanFindings(notice({ orgs: [] }))).resolves.toBe(0);
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('test send', () => {
  it('reaches every configured channel and reports each, audited', async () => {
    await svc.putSecurityPrefs(ORG, 'u', { webhookUrl: 'https://93.184.216.34/h', externalEmail: 'sec@example.com' });
    const token = lastConfirmToken();
    h.notify.mockClear();
    webhook.mockResolvedValueOnce({ ok: false, code: 500 });
    await expect(svc.sendTestNotice(ORG, 'u-admin')).resolves.toEqual({ relay: 'sent', webhook: { ok: false, code: 500 }, externalEmail: 'pending' });
    expect(h.notify).toHaveBeenCalledWith('N30', expect.not.arrayContaining([expect.objectContaining({ kind: 'address' })]),
      expect.objectContaining({ subject: 'Test: plugin security notifications' }), { immediate: true });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.security_notifications.test', orgId: ORG, details: { relay: 'sent', webhook: 'failed', externalEmail: 'pending' },
    }));

    await svc.confirmExternalEmail(token);
    await expect(svc.sendTestNotice(ORG, 'u-admin')).resolves.toMatchObject({ externalEmail: 'sent', webhook: { ok: true } });
  });

  it('without a webhook or address: relay only', async () => {
    await expect(svc.sendTestNotice(ORG, 'u-admin')).resolves.toEqual({ relay: 'sent', webhook: null, externalEmail: 'none' });
  });
});

describe('helpers', () => {
  it('masks an address', () => {
    expect(svc.maskEmail('alice@corp.example')).toBe('a***@corp.example');
    expect(svc.confirmUrl('a b')).toBe('https://pb.example.com/notifications/confirm?token=a%20b');
  });
});

describe('pipeline-owner notices', () => {
  it('N31 re-notifies a known finding when CISA newly lists it as known exploited', async () => {
    const base = { versionKey: 'plugin:p9', plugin: 'lint', version: '1.0.0', critical: 1, high: 0, flagged: true, orgs: [{ orgId: ORG }] };
    await expect(svc.notifyRescanFindings({ ...base, findings: [finding('CVE-7')] })).resolves.toBe(1);
    await expect(svc.notifyRescanFindings({ ...base, findings: [finding('CVE-7')] })).resolves.toBe(0);
    await expect(svc.notifyRescanFindings({ ...base, findings: [{ ...finding('CVE-7'), kev: true }], suggestedVersion: '1.0.1' })).resolves.toBe(1);
    expect(h.notify.mock.calls.at(-1)![2]).toMatchObject({ subject: 'Known-exploited vulnerability in plugin lint@1.0.0', text: expect.stringContaining('CISA Known Exploited') });
  });

  it('N32 tells the pipeline writers a pipeline runs a vulnerable version, once per (pipeline, version) a day', async () => {
    const n = {
      orgId: ORG,
      pipelineId: 'pipe-1',
      pipelineName: 'web',
      stepKey: 'Build/scan',
      plugin: 'lint',
      version: '1.0.0',
      severity: 'error' as const,
      warnings: [{ code: 'VULN_FLAGGED', severity: 'error' as const, message: 'flagged' }],
      suggestedVersion: '1.0.1',
      trigger: 'lookup' as const,
    };
    await svc.notifyPipelineVulnerable(n);
    await svc.notifyPipelineVulnerable(n);
    expect(h.notify).toHaveBeenCalledTimes(1);
    const [event, recipients, content] = h.notify.mock.calls[0]!;
    expect(event).toBe('N32');
    expect(recipients).toEqual([{ kind: 'org_permission', orgId: ORG, permission: 'pipelines:write' }]);
    expect(content).toMatchObject({ subject: expect.stringContaining('Pipeline web runs a vulnerable plugin (error)'), text: expect.stringContaining('Upgrade the step to lint@1.0.1') });
    expect(webhook).not.toHaveBeenCalled(); // no webhook configured
    // A removal attempt reads as such.
    await svc.notifyPipelineVulnerable({ ...n, pipelineId: 'pipe-2', trigger: 'removal', suggestedVersion: null });
    expect((h.notify.mock.calls[1]![2] as { text: string }).text).toContain('cannot be deleted while this pipeline uses it');
  });

  it('honours the org opt-out (notifyPipelineOwners: false) for N32 and N33', async () => {
    await svc.putSecurityPrefs(ORG, 'admin', { notifyPipelineOwners: false });
    await svc.notifyPipelineVulnerable({
      orgId: ORG, pipelineId: 'pipe-1', pipelineName: null, stepKey: 's', plugin: 'lint', version: '1.0.0', severity: 'critical', warnings: [], trigger: 'runtime-check',
    });
    await expect(svc.notifyAcceptancesLapsed([{ exposureId: 'e1', orgId: ORG, pipelineId: 'pipe-1', plugin: 'lint', version: '1.0.0', imageDigest: null, acceptedUntil: null, triagedBy: null, reason: null }])).resolves.toBe(0);
    expect(h.notify).not.toHaveBeenCalled();
    expect(() => svc.parsePrefsUpdate({ notifyPipelineOwners: 'no' })).toThrow(/notifyPipelineOwners must be a boolean/);
  });

  it('N33 lists an org\'s lapsed acceptances in one notice, to the pipeline writers and whoever accepted', async () => {
    const accepter = 'a'.repeat(24);
    await expect(svc.notifyAcceptancesLapsed([
      { exposureId: 'e1', orgId: ORG, pipelineId: 'pipe-1', pipelineName: 'web', plugin: 'lint', version: '1.0.0', imageDigest: null, acceptedUntil: new Date('2026-11-01T00:00:00Z'), triagedBy: accepter, reason: 'waiting on upstream' },
      { exposureId: 'e2', orgId: ORG, pipelineId: 'pipe-2', plugin: 'acme/scan', version: '2.0.0', imageDigest: null, acceptedUntil: null, triagedBy: null, reason: null },
    ])).resolves.toBe(1);
    const [event, recipients, content] = h.notify.mock.calls[0]!;
    expect(event).toBe('N33');
    expect(recipients).toEqual([{ kind: 'org_permission', orgId: ORG, permission: 'pipelines:write' }, { kind: 'org_members', orgId: ORG, userIds: [accepter] }]);
    expect(content).toMatchObject({ subject: '2 pipeline risk acceptances lapsed', text: expect.stringContaining('"waiting on upstream"') });
  });
});
