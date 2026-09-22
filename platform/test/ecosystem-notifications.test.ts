// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-ecosystem notification delivery (docs/plans/plugin-ecosystem.md §5b):
 * recipient RULES resolved at send time, per-user email opt-outs honoured only
 * for optional notices, one email per recipient (no shared To: line), the
 * in-app copy always, and N23 for Ecosystem Manager role changes.
 *
 * The models are an in-memory directory so the resolution logic runs for real.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const SYSTEM = '000000000000000000000001';

interface Row { [k: string]: unknown }
const db: {
  roles: Row[]; assignments: Row[]; memberships: Row[]; users: Row[]; prefs: Row[];
} = { roles: [], assignments: [], memberships: [], users: [], prefs: [] };

/** Tiny Mongo-ish matcher: equality, `$in`, `$ne`, array-contains. */
function matches(row: Row, q: Row): boolean {
  return Object.entries(q).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as { $in?: unknown[]; $ne?: unknown };
      if ('$in' in c) return c.$in!.map(String).includes(String(v));
      if ('$ne' in c) return v !== c.$ne && v !== undefined;
    }
    if (Array.isArray(v)) return v.includes(cond);
    return String(v) === String(cond);
  });
}
const query = (rows: () => Row[]) => ({
  find: (q: Row) => {
    const out = rows().filter((r) => matches(r, q));
    const chain = { select: () => chain, lean: () => Promise.resolve(out) };
    return chain;
  },
  findById: (id: string) => {
    const out = rows().find((r) => String(r._id) === String(id)) ?? null;
    const chain = { select: () => chain, lean: () => Promise.resolve(out) };
    return chain;
  },
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('mongoose', () => {
  class ObjectId { v: string; constructor(v: string) { this.v = v; } toString() { return this.v; } static isValid(v: unknown) { return typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v); } }
  const api = { Types: { ObjectId } };
  return { ...api, default: api };
});
jest.unstable_mockModule('../src/models/index.js', () => ({
  Role: query(() => db.roles),
  RoleAssignment: query(() => db.assignments),
  UserOrganization: query(() => db.memberships),
  User: query(() => db.users),
  UserPreferences: query(() => db.prefs),
}));
const mockInApp = jest.fn<(...a: unknown[]) => Promise<boolean>>();
jest.unstable_mockModule('../src/helpers/in-app-notify.js', () => ({
  sendInAppNotificationConfirmed: (...a: unknown[]) => mockInApp(...a),
}));
const mockSend = jest.fn<(...a: unknown[]) => Promise<boolean>>();
jest.unstable_mockModule('../src/utils/email.js', () => ({ emailService: { send: (...a: unknown[]) => mockSend(...a) } }));
const mockLineage = jest.fn<(...a: unknown[]) => Promise<{ rootOrgId: string }>>();
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ resolveOrgLineage: (...a: unknown[]) => mockLineage(...a) }));
const mockInc = jest.fn();
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: mockInc }));

const {
  countEcosystemApprovers, deliverEcosystemNotification, holdersOfPermission, notifyEcosystemManagerChange, resolveEcosystemRecipients,
} = await import('../src/services/ecosystem-notifications.js');

const PUB = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const TEAM = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ROOT = 'cccccccccccccccccccccccc';

function seed(): void {
  db.roles = [
    { _id: 'rEM', organizationId: SYSTEM, permissions: ['plugins:read', 'plugins:moderate', 'publishers:verify'] },
    { _id: 'rPubAdmin', organizationId: PUB, permissions: ['publishers:manage', 'plugin_installs:manage'] },
    { _id: 'rRootAdmin', organizationId: ROOT, permissions: ['plugin_installs:manage'] },
  ];
  db.assignments = [
    { userId: 'mod1', roleId: 'rEM', organizationId: SYSTEM },
    { userId: 'mod2', roleId: 'rEM', organizationId: SYSTEM },
    { userId: 'gone', roleId: 'rEM', organizationId: SYSTEM }, // membership inactive
    { serviceAccountId: 'sa1', userId: null, roleId: 'rEM', organizationId: SYSTEM },
    { userId: 'pubAdmin', roleId: 'rPubAdmin', organizationId: PUB },
    { userId: 'rootAdmin', roleId: 'rRootAdmin', organizationId: ROOT },
  ];
  db.memberships = [
    { userId: 'mod1', organizationId: SYSTEM, isActive: true, role: 'member' },
    { userId: 'mod2', organizationId: SYSTEM, isActive: true, role: 'member' },
    { userId: 'mod2', organizationId: PUB, isActive: true, role: 'member' }, // conflict of interest for PUB requests
    { userId: 'gone', organizationId: SYSTEM, isActive: false, role: 'member' },
    { userId: 'pubAdmin', organizationId: PUB, isActive: true, role: 'admin' },
    { userId: 'pubOwner', organizationId: PUB, isActive: true, role: 'owner' },
    { userId: 'teamOwner', organizationId: TEAM, isActive: true, role: 'owner' },
    { userId: 'rootAdmin', organizationId: ROOT, isActive: true, role: 'admin' },
  ];
  db.users = [
    { _id: 'mod1', email: 'mod1@x.io' },
    { _id: 'mod2', email: 'mod2@x.io' },
    { _id: 'pubAdmin', email: 'pubadmin@pub.io', lastActiveOrgId: PUB },
    { _id: 'pubOwner', email: 'owner@pub.io' },
    { _id: 'teamOwner', email: 'team@t.io' },
    { _id: 'rootAdmin', email: 'root@r.io' },
    { _id: 'sa', email: 'sa@x.io', isSuperAdmin: true, lastActiveOrgId: ROOT },
    { _id: 'requester', email: 'req@x.io', lastActiveOrgId: TEAM },
  ];
  db.prefs = [];
}

beforeEach(() => {
  seed();
  mockInApp.mockReset().mockResolvedValue(true);
  mockSend.mockReset().mockResolvedValue(true);
  mockLineage.mockReset().mockResolvedValue({ rootOrgId: ROOT });
  mockInc.mockReset();
});

describe('holdersOfPermission', () => {
  it('returns ACTIVE human members whose Roles in that org carry the permission', async () => {
    expect((await holdersOfPermission(SYSTEM, 'plugins:moderate')).sort()).toEqual(['mod1', 'mod2']);
    expect(await holdersOfPermission(PUB, 'plugins:moderate')).toEqual([]);
  });
});

describe('countEcosystemApprovers (§3.0.1)', () => {
  it('counts the holders, the ones left after conflicts of interest, and the superadmins', async () => {
    expect(await countEcosystemApprovers('plugins:moderate')).toEqual({ holders: 2, eligible: 2, superadmins: 1 });
    // mod2 belongs to PUB; mod1 submitted.
    expect(await countEcosystemApprovers('plugins:moderate', { memberOfOrgIds: [PUB], userIds: ['mod1'] }))
      .toEqual({ holders: 2, eligible: 0, superadmins: 1 });
    expect(await countEcosystemApprovers('publishers:verify', { userIds: ['sa'] })).toEqual({ holders: 2, eligible: 2, superadmins: 0 });
  });
});

describe('resolveEcosystemRecipients', () => {
  it('moderators: the system org\'s holders minus members of the requesting org (conflict of interest)', async () => {
    const { users } = await resolveEcosystemRecipients([{ kind: 'moderators', permission: 'plugins:moderate', excludeMembersOfOrgId: PUB }]);
    expect([...users.keys()]).toEqual(['mod1']);
    expect(users.get('mod1')).toEqual({ inboxOrgId: SYSTEM });
  });

  it('moderators: excluded users drop out; with nobody left, superadmins receive it', async () => {
    const { users } = await resolveEcosystemRecipients([{ kind: 'moderators', permission: 'publishers:verify', excludeUserIds: ['mod1', 'mod2'] }]);
    expect([...users.keys()]).toEqual(['sa']);
    expect(users.get('sa')).toEqual({ inboxOrgId: SYSTEM });
  });

  it('moderators: nobody at all → empty (logged)', async () => {
    const { users } = await resolveEcosystemRecipients([{ kind: 'moderators', permission: 'plugins:moderate', excludeUserIds: ['mod1', 'mod2', 'sa'] }]);
    expect(users.size).toBe(0);
  });

  it('org_permission: holders in the org, else the owners', async () => {
    expect([...(await resolveEcosystemRecipients([{ kind: 'org_permission', orgId: PUB, permission: 'publishers:manage' }])).users.keys()]).toEqual(['pubAdmin']);
    db.assignments = db.assignments.filter((a) => a.userId !== 'pubAdmin');
    expect([...(await resolveEcosystemRecipients([{ kind: 'org_permission', orgId: PUB, permission: 'publishers:manage' }])).users.keys()]).toEqual(['pubOwner']);
  });

  it('org_permission: an inherited team falls back to its ROOT org\'s holders, inboxed in the root', async () => {
    const { users } = await resolveEcosystemRecipients([{ kind: 'org_permission', orgId: TEAM, permission: 'plugin_installs:manage', inheritFromRoot: true }]);
    expect([...users.entries()]).toEqual([['rootAdmin', { inboxOrgId: ROOT }]]);
  });

  it('org_permission: a team with no holders anywhere reaches its own owners', async () => {
    mockLineage.mockResolvedValue({ rootOrgId: TEAM });
    const { users } = await resolveEcosystemRecipients([{ kind: 'org_permission', orgId: TEAM, permission: 'plugin_installs:manage', inheritFromRoot: true }]);
    expect([...users.keys()]).toEqual(['teamOwner']);
  });

  it('user: the named user, inboxed in the given org or their last active org; unknown users drop', async () => {
    const { users } = await resolveEcosystemRecipients([
      { kind: 'user', userId: 'requester' },
      { kind: 'user', userId: 'pubAdmin', orgId: SYSTEM },
      { kind: 'user', userId: 'nobody' },
    ]);
    expect([...users.entries()]).toEqual([['requester', { inboxOrgId: TEAM }], ['pubAdmin', { inboxOrgId: SYSTEM }]]);
  });

  it('superadmins + address; a user reached by two rules is counted once', async () => {
    const { users, addresses } = await resolveEcosystemRecipients([
      { kind: 'superadmins' }, { kind: 'user', userId: 'sa' }, { kind: 'address', email: 'anon@sub.io' },
    ]);
    expect([...users.entries()]).toEqual([['sa', { inboxOrgId: ROOT }]]);
    expect([...addresses]).toEqual(['anon@sub.io']);
  });
});

describe('deliverEcosystemNotification', () => {
  it('sends the in-app copy and ONE email per recipient (no shared To: line)', async () => {
    const report = await deliverEcosystemNotification({
      event: 'N8',
      subject: 'Suspended',
      text: 'Your listing was suspended',
      recipients: [{ kind: 'org_permission', orgId: PUB, permission: 'publishers:manage' }, { kind: 'moderators', permission: 'plugins:moderate' }],
    });
    expect(report).toEqual({ recipientCount: 3, inApp: 3, emailed: 3, suppressed: 0, failed: 0 });
    expect(mockSend).toHaveBeenCalledTimes(3);
    for (const [arg] of mockSend.mock.calls) expect(typeof (arg as { to: unknown }).to).toBe('string');
    expect(mockInApp).toHaveBeenCalledWith({ recipientOrgId: PUB, recipientUserId: 'pubAdmin', subject: 'Suspended', content: 'Your listing was suspended' });
  });

  it('honours an opt-out in the inbox org for an optional notice, but always sends the in-app copy', async () => {
    db.prefs = [
      { userId: 'pubAdmin', organizationId: PUB, notifications: { ecosystem: { reviewsEmail: false } } },
      // A preference in a DIFFERENT org does not apply.
      { userId: 'mod1', organizationId: PUB, notifications: { ecosystem: { reviewsEmail: false } } },
    ];
    const report = await deliverEcosystemNotification({
      event: 'N15',
      subject: 'New review',
      text: 'x',
      recipients: [{ kind: 'org_permission', orgId: PUB, permission: 'publishers:manage' }, { kind: 'user', userId: 'mod1', orgId: SYSTEM }],
    });
    expect(report).toMatchObject({ inApp: 2, emailed: 1, suppressed: 1 });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: 'mod1@x.io' }));
  });

  it('ignores opt-outs for a transactional notice and for a mandatory one', async () => {
    db.prefs = [{ userId: 'mod1', organizationId: SYSTEM, notifications: { ecosystem: { moderationDigestEmail: false } } }];
    const mods = [{ kind: 'moderators' as const, permission: 'plugins:moderate' as const }];
    expect(await deliverEcosystemNotification({ event: 'N24', subject: 's', text: 't', recipients: mods })).toMatchObject({ emailed: 1, suppressed: 1 });
    expect(await deliverEcosystemNotification({ event: 'N24', subject: 's', text: 't', recipients: mods, mandatory: true })).toMatchObject({ emailed: 2, suppressed: 0 });
    expect(await deliverEcosystemNotification({ event: 'N28', subject: 's', text: 't', recipients: mods })).toMatchObject({ emailed: 2, suppressed: 0 });
  });

  it('delivers only the requested channels', async () => {
    const onlyEmail = await deliverEcosystemNotification({ event: 'N2', subject: 's', text: 't', channels: ['email'], recipients: [{ kind: 'moderators', permission: 'plugins:moderate' }] });
    expect(onlyEmail).toMatchObject({ inApp: 0, emailed: 2 });
    expect(mockInApp).not.toHaveBeenCalled();
    const inAppOnly = await deliverEcosystemNotification({ event: 'N26', subject: 's', text: 't', recipients: [{ kind: 'user', userId: 'pubAdmin' }] });
    expect(inAppOnly).toMatchObject({ inApp: 1, emailed: 0 });
  });

  it('emails an anonymous submitter address (N1) and counts failed sends', async () => {
    mockSend.mockResolvedValueOnce(false);
    const report = await deliverEcosystemNotification({ event: 'N1', subject: 's', text: 't', recipients: [{ kind: 'address', email: 'anon@sub.io' }] });
    expect(report).toMatchObject({ recipientCount: 1, emailed: 0, failed: 1 });
    expect(mockInc).toHaveBeenCalledWith('ecosystem_notification_failed_total', { event: 'N1' });
    mockSend.mockRejectedValueOnce(new Error('smtp'));
    expect(await deliverEcosystemNotification({ event: 'N3', subject: 's', text: 't', recipients: [{ kind: 'address', email: 'anon@sub.io' }] })).toMatchObject({ failed: 1 });
  });

  it('skips the in-app copy for a user with no inbox org and counts an undelivered in-app message', async () => {
    db.users.push({ _id: 'homeless', email: 'h@x.io' });
    mockInApp.mockResolvedValueOnce(false);
    const report = await deliverEcosystemNotification({
      event: 'N12', subject: 's', text: 't', recipients: [{ kind: 'user', userId: 'homeless' }, { kind: 'user', userId: 'requester' }],
    });
    expect(report).toMatchObject({ recipientCount: 2, inApp: 0, emailed: 2 });
    expect(mockInApp).toHaveBeenCalledTimes(1);
  });
});

describe('notifyEcosystemManagerChange (N23)', () => {
  it('tells every superadmin and the affected user, in-app + email', async () => {
    await notifyEcosystemManagerChange({ userId: 'mod1', added: true, actorUserId: 'sa' });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      to: 'mod1@x.io', subject: 'mod1@x.io was added to the Ecosystem Manager role',
    }));
    expect((mockSend.mock.calls[0][0] as { text: string }).text).toContain('by sa@x.io');
    expect(mockInApp).toHaveBeenCalledWith(expect.objectContaining({ recipientUserId: 'mod1', recipientOrgId: SYSTEM }));
  });

  it('names a removal, and falls back to the id for an unknown user', async () => {
    await notifyEcosystemManagerChange({ userId: 'ghost', added: false });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ subject: 'ghost was removed from the Ecosystem Manager role' }));
  });

  it('never throws', async () => {
    mockInApp.mockRejectedValue(new Error('down'));
    await expect(notifyEcosystemManagerChange({ userId: 'mod1', added: true })).resolves.toBeUndefined();
  });
});
