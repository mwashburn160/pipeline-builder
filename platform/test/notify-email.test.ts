// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /internal/notify-email — the internal email-send endpoint
 * compliance calls. Exercises recipient resolution (targetUsers intersected
 * with active membership, or all admins when null), validation, and the
 * zero-recipient case. Models + EmailService are mocked.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockMembershipFind = jest.fn<AnyFn>();
const mockUserFind = jest.fn<AnyFn>();
const mockSend = jest.fn<(...a: unknown[]) => Promise<boolean>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));

jest.unstable_mockModule('mongoose', () => {
  // Functional ObjectId so `toOrgId` (org-id.js) can run: 24-hex → ObjectId,
  // else the string unchanged. Include a `default` export (org-id.js default-imports mongoose).
  class ObjectId {
    v: unknown;
    constructor(v?: unknown) { this.v = v; }
    toString() { return String(this.v); }
    static isValid(v: unknown) { return typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v); }
  }
  class Schema { constructor() { /* no-op */ } index() { /* no-op */ } method() { /* no-op */ } static Types = { Mixed: class {}, ObjectId }; }
  const api = { Types: { Mixed: class {}, ObjectId }, Schema, models: {}, model: jest.fn<AnyFn>() };
  return { ...api, default: api };
});

// A pass-through stand-in for the real service-token verification: it leaves
// `req.user` exactly as the test set it, so the ROUTE-LEVEL suite below can
// present any principal and let the real `requireInternalService` decide.
jest.unstable_mockModule('../src/middleware/index.js', () => ({
  requireServiceAuth: jest.fn<AnyFn>((_req: any, _res: any, next: any) => next()),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  UserOrganization: { find: (...a: unknown[]) => ({ lean: () => mockMembershipFind(...a) }) },
  User: { find: (...a: unknown[]) => ({ lean: () => mockUserFind(...a) }) },
}));

jest.unstable_mockModule('../src/utils/email.js', () => ({
  emailService: { send: (...a: unknown[]) => mockSend(...a) },
  default: { send: (...a: unknown[]) => mockSend(...a) },
}));

// Ecosystem notices are delivered by their own service,
// tested in ecosystem-notifications.test.ts; here only the relay's branching.
const mockDeliver = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/services/ecosystem-notifications.js', () => ({
  deliverEcosystemNotification: (...a: unknown[]) => mockDeliver(...a),
}));

// EMAIL_ENABLED as platform config exposes it — mutable per test for the status route.
const mockEmailConfig = { enabled: true };
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ email: mockEmailConfig }));

const { notifyEmail: handleNotifyEmail, notifyEmailStatus } = await import('../src/controllers/notify-email.js');
const notifyEmailRouter = (await import('../src/routes/notify-email.js')).default as any;

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  mockDeliver.mockReset();
  mockMembershipFind.mockReset();
  mockUserFind.mockReset();
  mockSend.mockReset();
  mockSend.mockResolvedValue(true);
});

describe('handleNotifyEmail', () => {
  it('400s when required fields are missing', async () => {
    const res = mockRes();
    await handleNotifyEmail({ body: { subject: 's', text: 't' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockMembershipFind).not.toHaveBeenCalled();
  });

  it('emails all active admins/owners when targetUsers is null', async () => {
    mockMembershipFind.mockResolvedValue([
      { userId: 'u1', role: 'admin' },
      { userId: 'u2', role: 'member' },
      { userId: 'u3', role: 'owner' },
    ]);
    mockUserFind.mockResolvedValue([{ email: 'a@x.com' }, { email: 'o@x.com' }]);

    const res = mockRes();
    await handleNotifyEmail({ body: { orgId: 'org-1', targetUsers: null, subject: 'S', text: 'T' }, user: { sub: 'service:compliance', organizationId: 'org-1', isSuperAdmin: false } } as any, res);

    // only the admin + owner userIds are looked up (member filtered out)
    const userIdArg = (mockUserFind.mock.calls[0][0] as { _id: { $in: string[] } })._id.$in;
    expect(userIdArg).toEqual(['u1', 'u3']);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: ['a@x.com', 'o@x.com'], subject: 'S', text: 'T' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('intersects targetUsers with active membership (drops outsiders)', async () => {
    mockMembershipFind.mockResolvedValue([
      { userId: 'u1', role: 'member' },
      { userId: 'u2', role: 'admin' },
    ]);
    mockUserFind.mockResolvedValue([{ email: 'u1@x.com' }]);

    const res = mockRes();
    await handleNotifyEmail({ body: { orgId: 'org-1', targetUsers: ['u1', 'u-outsider'], subject: 'S', text: 'T' }, user: { sub: 'service:compliance', organizationId: 'org-1', isSuperAdmin: false } } as any, res);

    const userIdArg = (mockUserFind.mock.calls[0][0] as { _id: { $in: string[] } })._id.$in;
    expect(userIdArg).toEqual(['u1']); // u-outsider not a member → dropped
  });

  it('returns ok with recipientCount 0 when no recipients resolve (no send)', async () => {
    mockMembershipFind.mockResolvedValue([]);
    const res = mockRes();
    await handleNotifyEmail({ body: { orgId: 'org-1', targetUsers: null, subject: 'S', text: 'T' }, user: { sub: 'service:compliance', organizationId: 'org-1', isSuperAdmin: false } } as any, res);
    expect(mockSend).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { ok: true, recipientCount: 0 } }));
  });

  it('500s when the resolution/send throws', async () => {
    mockMembershipFind.mockRejectedValue(new Error('mongo down'));
    const res = mockRes();
    await handleNotifyEmail({ body: { orgId: 'org-1', subject: 'S', text: 'T' }, user: { sub: 'service:compliance', organizationId: 'org-1', isSuperAdmin: false } } as any, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('403s when a non-sysadmin service token targets a different org (no recipient resolution)', async () => {
    const res = mockRes();
    await handleNotifyEmail({
      body: { orgId: 'org-victim', subject: 'S', text: 'T' },
      user: { sub: 'service:compliance', organizationId: 'org-attacker', isSuperAdmin: false },
    } as any, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockMembershipFind).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('403s an org-less non-sysadmin service token (fail-closed — cannot spoof any org)', async () => {
    const res = mockRes();
    await handleNotifyEmail({
      body: { orgId: 'org-victim', subject: 'S', text: 'T' },
      user: { sub: 'service:compliance', isSuperAdmin: false }, // no organizationId claim
    } as any, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockMembershipFind).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('proceeds when a non-sysadmin service token targets its OWN org', async () => {
    mockMembershipFind.mockResolvedValue([{ userId: 'u1', role: 'admin' }]);
    mockUserFind.mockResolvedValue([{ email: 'a@x.com' }]);

    const res = mockRes();
    await handleNotifyEmail({
      body: { orgId: 'org-self', subject: 'S', text: 'T' },
      user: { sub: 'service:compliance', organizationId: 'org-self', isSuperAdmin: false },
    } as any, res);

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: ['a@x.com'] }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('lets a sysadmin service token target any org (cross-org allowed)', async () => {
    mockMembershipFind.mockResolvedValue([{ userId: 'u1', role: 'owner' }]);
    mockUserFind.mockResolvedValue([{ email: 'o@x.com' }]);

    const res = mockRes();
    await handleNotifyEmail({
      body: { orgId: 'org-other', subject: 'S', text: 'T' },
      user: { sub: 'service:platform', organizationId: 'org-home', isSuperAdmin: true },
    } as any, res);

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: ['o@x.com'] }));
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('handleNotifyEmail — ecosystem notices (plugin)', () => {
  const plugin = { sub: 'service:plugin', principalType: 'service', organizationId: '000000000000000000000001', isSuperAdmin: false };
  const notice = { event: 'N23', subject: 'S', text: 'T', recipients: [{ kind: 'superadmins' }] };

  it('delivers a valid notice from the plugin service and reports counts', async () => {
    mockDeliver.mockResolvedValue({ recipientCount: 2, inApp: 2, emailed: 2, suppressed: 0, failed: 0 });
    const res = mockRes();
    await handleNotifyEmail({ body: notice, user: plugin } as any, res);
    expect(mockDeliver).toHaveBeenCalledWith(expect.objectContaining({ event: 'N23', recipients: [{ kind: 'superadmins' }] }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ok: true, recipientCount: 2 }) }));
  });

  it('SECURITY: refuses an ecosystem notice from any other caller (compliance cannot fan out across orgs)', async () => {
    const res = mockRes();
    await handleNotifyEmail({ body: notice, user: { ...plugin, sub: 'service:compliance' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('400s an invalid notice without delivering anything', async () => {
    const res = mockRes();
    await handleNotifyEmail({ body: { ...notice, recipients: [{ kind: 'org_permission', orgId: 'o', permission: 'plugins:moderate' }] }, user: plugin } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('SECURITY: admits a raw address only on the plugin security notices (N30/N31), never on other events', async () => {
    mockDeliver.mockResolvedValue({ recipientCount: 1, inApp: 0, emailed: 1, suppressed: 0, failed: 0 });
    const address = [{ kind: 'address', email: 'sec@example.com' }];
    const ok = mockRes();
    await handleNotifyEmail({ body: { ...notice, event: 'N31', recipients: address }, user: plugin } as any, ok);
    expect(ok.status).toHaveBeenCalledWith(200);
    const refused = mockRes();
    await handleNotifyEmail({ body: { ...notice, event: 'N21', recipients: address }, user: plugin } as any, refused);
    expect(refused.status).toHaveBeenCalledWith(400);
    expect(mockDeliver).toHaveBeenCalledTimes(1);
  });

  it('400s a tenant-email body from the plugin service (it only sends ecosystem notices)', async () => {
    const res = mockRes();
    await handleNotifyEmail({ body: { orgId: 'org-1', subject: 'S', text: 'T' }, user: plugin } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockMembershipFind).not.toHaveBeenCalled();
  });

  it('500s when delivery throws (so the sender keeps the row for retry)', async () => {
    mockDeliver.mockRejectedValue(new Error('mongo down'));
    const res = mockRes();
    await handleNotifyEmail({ body: notice, user: plugin } as any, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// GET /internal/notify-email/status — the plugin service's anonymous-submission
// API is only available when outbound email is on.
describe('notifyEmailStatus', () => {
  it.each([[true], [false]])('reports enabled=%s straight from EMAIL_ENABLED', (enabled) => {
    mockEmailConfig.enabled = enabled;
    const res = mockRes();
    notifyEmailStatus({ user: { sub: 'service:plugin' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { enabled } }));
  });

  it('reveals nothing but the switch (no provider, host or sender)', () => {
    mockEmailConfig.enabled = true;
    const res = mockRes();
    notifyEmailStatus({} as any, res);
    const payload = (res.json.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(Object.keys(payload)).toEqual(['enabled']);
  });
});

// ---------------------------------------------------------------------------
// The ROUTE-LEVEL caller gate — who may read the switch, and who may send.
//
// Reading the switch and sending mail are separate authorities and are gated
// separately: `ask` (the agent's notification diagnosis) reads
// GET /status, and must NEVER be admitted to POST / — a model, or a
// prompt-injected message, would otherwise be one step from making the instance
// send mail to an address it chose. `requireServiceAuth` is a pass-through here;
// the real `requireInternalService` (from the api-core mock's faithful replica)
// is what decides, off the `service:<name>` subject bound to the signing key.
// ---------------------------------------------------------------------------

/** A verified peer service, as `requireServiceAuth` leaves `req.user`. */
const servicePrincipal = (name: string) => ({
  sub: `service:${name}`,
  principalType: 'service' as const,
  token_use: 'access' as const,
  organizationId: 'org-1',
  isSuperAdmin: false,
});

/** Drive the mounted router with one request and resolve the captured response. */
function drive(method: 'GET' | 'POST', url: string, user: unknown, body: unknown = {}): Promise<any> {
  const res = mockRes();
  const req: any = { method, url, originalUrl: url, body, query: {}, headers: {}, header: () => undefined, user };
  return new Promise((resolve) => {
    notifyEmailRouter(req, res, () => undefined);
    setImmediate(() => resolve(res));
  });
}

describe('internal caller gate', () => {
  beforeEach(() => { mockEmailConfig.enabled = true; });

  it('admits `ask` to GET /status — the agent diagnoses "nothing arrives" off this switch', async () => {
    const res = await drive('GET', '/status', servicePrincipal('ask'));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { enabled: true } }));
  });

  it('admits `plugin` to GET /status (the anonymous-submission precondition)', async () => {
    const res = await drive('GET', '/status', servicePrincipal('plugin'));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each([['compliance'], ['billing'], ['pipeline']])(
    'still refuses an unlisted service (%s) on GET /status',
    async (name) => {
      const res = await drive('GET', '/status', servicePrincipal(name));
      expect(res.status).toHaveBeenCalledWith(403);
    },
  );

  it('refuses a USER token on GET /status, however privileged', async () => {
    const res = await drive('GET', '/status', { sub: 'u-1', organizationId: 'org-1', isSuperAdmin: true });
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('SECURITY: `ask` may read the switch but may NOT send — POST / refuses it', async () => {
    const res = await drive('POST', '/', servicePrincipal('ask'), { orgId: 'org-1', subject: 'S', text: 'T' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('keeps the send route on its own two callers', async () => {
    mockMembershipFind.mockResolvedValue([]);
    const compliance = await drive('POST', '/', servicePrincipal('compliance'), { orgId: 'org-1', subject: 'S', text: 'T' });
    expect(compliance.status).not.toHaveBeenCalledWith(403);
    const quota = await drive('POST', '/', servicePrincipal('quota'), { orgId: 'org-1', subject: 'S', text: 'T' });
    expect(quota.status).toHaveBeenCalledWith(403);
  });
});
