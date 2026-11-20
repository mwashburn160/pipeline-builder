// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for the invitation lifecycle: send → accept (email/password
 * and OAuth), inviter exit, seat caps and the role carry-over ceiling.
 *
 * The mocked suites (`invitation-accept-*.test.ts`, `org-members-revoke-
 * invitations.test.ts`, `seats-*.test.ts`) pin each branch against a stand-in
 * collection. What only a real replica set can tell us:
 *   - accept runs ONE transaction: a refusal discovered late (the post-write seat
 *     re-count) rolls back the membership, the Role assignments AND the
 *     invitation's `accepted` flip together;
 *   - the already-member tombstone survives its own commit while the caller
 *     still sees INV_ALREADY_MEMBER;
 *   - removing / deactivating the inviter revokes their PENDING invitations in
 *     the same transaction, and acceptance re-checks the inviter as a backstop
 *     for invitations the revoke did not reach;
 *   - an admin invitation, or named Roles, whose inviter was demoted before the
 *     click are granted only up to the inviter's CURRENT ceiling (read from the
 *     real `role_assignments`), with the rest dropped and reported.
 *
 * Tokens and refresh sessions are deliberately out of scope (being reworked
 * elsewhere): every assertion is on Invitation / UserOrganization /
 * RoleAssignment state.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default).
 */

import { jest, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
// Mail is a no-op (emailService.send returns true without a transport).
delete process.env.EMAIL_ENABLED;

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('invitation accept (real Mongo replica set)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, invitationService: any, orgMembersService: any, roles: any, seats: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const OWNER_ACTOR = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] };

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    // Collections must exist before a transaction writes to them (Mongo 6
    // refuses implicit collection creation inside a multi-doc transaction).
    for (const model of [m.User, m.UserOrganization, m.Organization, m.Invitation, m.Role, m.RoleAssignment, m.UserTotp, m.WebAuthnCredential, m.MfaRecoveryCodes]) {
      await model.createCollection().catch(() => undefined);
    }
    await m.Invitation.syncIndexes();
    ({ invitationService } = await import('../src/services/invitation-service.js'));
    ({ orgMembersService } = await import('../src/services/org-members-service.js'));
    roles = await import('../src/services/roles-service.js');
    seats = await import('../src/helpers/seats.js');
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  let orgId: string;
  let ownerId: string;
  /** An admin (not the owner) — the usual inviter. */
  let adminId: string;
  /** A custom Role carrying an admin-only permission (`members:manage`). */
  let securityRoleId: string;
  /** A custom Role granting only `invitations:manage` — a non-admin delegate. */
  let inviterRoleId: string;

  async function createUser(username: string, extra: Record<string, unknown> = {}) {
    return m.User.create({
      username, email: `${username}@example.com`, password: 'Passw0rd!secret', isEmailVerified: true, ...extra,
    });
  }

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Organization, m.Invitation, m.Role, m.RoleAssignment]) {
      await model.deleteMany({});
    }
    const owner = await createUser('owner');
    ownerId = String(owner._id);
    const org = await m.Organization.create({ name: 'Acme', owner: owner._id, tier: 'pro' });
    // Unlimited unless a test sets a cap (a tier default would otherwise apply).
    await m.Organization.updateOne({ _id: org._id }, { $set: { 'quotas.seats': -1 } });
    orgId = String(org._id);
    await m.UserOrganization.create({ userId: owner._id, organizationId: org._id, role: 'owner', isActive: true });
    await roles.seedDefaultRoles(org._id, owner._id);

    const admin = await createUser('admin');
    adminId = String(admin._id);
    await m.UserOrganization.create({ userId: admin._id, organizationId: org._id, role: 'admin', isActive: true });
    await roles.ensureBaselineRole(admin._id, org._id);
    await roles.assignBuiltinAdminRole(admin._id, org._id);
    // ensureBaselineRole recomputed the cached role from the Member floor alone;
    // re-derive it now that the Admin Role is held, so the label reads `admin`.
    await roles.recomputeUserOrgRole(admin._id, org._id);
    expect((await m.UserOrganization.findOne({ userId: admin._id }).lean()).role).toBe('admin');

    securityRoleId = String((await m.Role.create({
      organizationId: org._id, name: 'Security Officer', grantsRole: 'member', permissions: ['members:manage', 'audit:read'], system: false,
    }))._id);
    inviterRoleId = String((await m.Role.create({
      organizationId: org._id, name: 'People Manager', grantsRole: 'member', permissions: ['invitations:manage'], system: false,
    }))._id);
  });

  const send = (overrides: Record<string, unknown> = {}) => invitationService.send({
    orgId,
    inviterId: adminId,
    inviterCanManage: true,
    inviterIsAdmin: true,
    email: 'invitee@example.com',
    role: 'member',
    invitationType: 'any',
    ...overrides,
  });

  const membershipOf = (userId: string) => m.UserOrganization.findOne({ userId, organizationId: orgId }).lean();
  const roleIdsOf = async (userId: string) => (await m.RoleAssignment.find({ userId, organizationId: orgId }).lean())
    .map((a: { roleId: unknown }) => String(a.roleId)).sort();
  const builtinRoleId = async (grantsRole: string) => String((await m.Role.findOne({ organizationId: orgId, grantsRole, system: true, seedBundle: { $exists: false } }).lean())._id);

  // ---------------------------------------------------------------------------
  // Email/password accept
  // ---------------------------------------------------------------------------

  it('send → accept by an existing password user creates the membership with the invited role, once', async () => {
    const { invitation, token } = await send({ role: 'admin', roleIds: [securityRoleId] });
    const invitee = await createUser('invitee');

    const result = await invitationService.accept(token, String(invitee._id));

    expect(result).toMatchObject({ role: 'admin', email: 'invitee@example.com', organizationId: orgId, grantedRoleIds: [securityRoleId] });
    const membership = await membershipOf(String(invitee._id));
    expect(membership.role).toBe('admin');
    expect(membership.isActive).toBe(true);
    // Member floor + built-in Admin + the named Role, all as real assignment rows.
    expect(await roleIdsOf(String(invitee._id))).toEqual(
      [await builtinRoleId('member'), await builtinRoleId('admin'), securityRoleId].sort(),
    );

    const stored = await m.Invitation.findById(invitation._id).lean();
    expect(stored.status).toBe('accepted');
    expect(String(stored.acceptedBy)).toBe(String(invitee._id));
    expect(stored.acceptedVia).toBe('email');
    expect(String((await m.User.findById(invitee._id).lean()).lastActiveOrgId)).toBe(orgId);

    // Single-use: a second click is refused and changes nothing.
    await expect(invitationService.accept(token, String(invitee._id))).rejects.toThrow('INV_ACCEPTED');
    expect(await m.UserOrganization.countDocuments({ userId: invitee._id })).toBe(1);
  });

  it('refuses an accept by a signed-in user whose email is not the invited one', async () => {
    const { invitation, token } = await send();
    const other = await createUser('someone-else');
    await expect(invitationService.accept(token, String(other._id))).rejects.toThrow('INV_EMAIL_MISMATCH');
    expect(await membershipOf(String(other._id))).toBeNull();
    expect((await m.Invitation.findById(invitation._id).lean()).status).toBe('pending');
  });

  it('tombstones the invitation for an existing member but still answers INV_ALREADY_MEMBER (write survives the commit)', async () => {
    const { invitation, token } = await send();
    const invitee = await createUser('invitee');
    // They joined some other way after the invitation went out.
    await m.UserOrganization.create({ userId: invitee._id, organizationId: orgId, role: 'member', isActive: true });

    await expect(invitationService.accept(token, String(invitee._id))).rejects.toThrow('INV_ALREADY_MEMBER');
    const stored = await m.Invitation.findById(invitation._id).lean();
    expect(stored.status).toBe('accepted');
    expect(String(stored.acceptedBy)).toBe(String(invitee._id));
    expect(await m.UserOrganization.countDocuments({ userId: invitee._id })).toBe(1);
  });

  it('refuses an expired invitation', async () => {
    const { invitation, token } = await send();
    await m.Invitation.updateOne({ _id: invitation._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const invitee = await createUser('invitee');

    await expect(invitationService.accept(token, String(invitee._id))).rejects.toThrow('INV_EXPIRED');
    expect(await membershipOf(String(invitee._id))).toBeNull();
    // Expired rows stop reserving a seat by `expiresAt`, whatever their status.
    expect((await seats.pooledSeatUsage(orgId)).used).toBe(2);
  });

  // Regression: the expiry write used to be inside the accept transaction that
  // INV_EXPIRED aborts, so it was always rolled back.
  it('records the expiry on the row when an accept hits an expired invitation', async () => {
    const { invitation, token } = await send();
    await m.Invitation.updateOne({ _id: invitation._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const invitee = await createUser('invitee');

    await expect(invitationService.accept(token, String(invitee._id))).rejects.toThrow('INV_EXPIRED');
    expect((await m.Invitation.findById(invitation._id).lean()).status).toBe('expired');
  });

  it('refuses an email accept of an OAuth-only invitation', async () => {
    const { token } = await send({ invitationType: 'oauth', allowedOAuthProviders: ['google'] });
    const invitee = await createUser('invitee');
    await expect(invitationService.accept(token, String(invitee._id))).rejects.toThrow('INV_EMAIL_NOT_ALLOWED');
    expect(await membershipOf(String(invitee._id))).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // OAuth accept
  // ---------------------------------------------------------------------------

  it('OAuth accept for a brand-new invitee creates a verified, provider-linked user and joins them', async () => {
    const { invitation, token } = await send({ invitationType: 'oauth', allowedOAuthProviders: ['google'] });

    const result = await invitationService.acceptViaOAuth(token, 'google', {
      id: 'google-sub-1', email: 'Invitee@Example.com', name: 'Invitee',
    });

    const user = await m.User.findById(result.userId).lean();
    expect(user.email).toBe('invitee@example.com');
    expect(user.isEmailVerified).toBe(true);
    expect(user.oauth.google.id).toBe('google-sub-1');
    expect((await membershipOf(result.userId)).role).toBe('member');
    // The new account owns no personal org — it joins the inviting org only.
    expect(await m.UserOrganization.countDocuments({ userId: user._id })).toBe(1);
    const stored = await m.Invitation.findById(invitation._id).lean();
    expect(stored.status).toBe('accepted');
    expect(stored.acceptedVia).toBe('google');
  });

  it('OAuth accept refuses a provider the invitation does not allow, and an unverified same-email account', async () => {
    const { invitation, token } = await send({ invitationType: 'oauth', allowedOAuthProviders: ['google'] });
    await expect(invitationService.acceptViaOAuth(token, 'github', { id: 'gh-1', email: 'invitee@example.com' }))
      .rejects.toThrow('INV_OAUTH_NOT_ALLOWED');

    // An unverified account squatting on the invited address must not be linked.
    await createUser('invitee', { isEmailVerified: false });
    await expect(invitationService.acceptViaOAuth(token, 'google', { id: 'google-sub-2', email: 'invitee@example.com' }))
      .rejects.toThrow('ACCOUNT_EMAIL_UNVERIFIED');
    expect(await m.UserOrganization.countDocuments({ organizationId: orgId })).toBe(2);
    expect((await m.Invitation.findById(invitation._id).lean()).status).toBe('pending');
  });

  it('a signed-in accept naming a provider counts only when the account really holds that linked identity', async () => {
    const { invitation, token } = await send({ invitationType: 'oauth', allowedOAuthProviders: ['google'] });
    const unlinked = await createUser('invitee');
    await expect(invitationService.accept(token, String(unlinked._id), 'google')).rejects.toThrow('INV_OAUTH_NOT_ALLOWED');

    await m.User.updateOne({ _id: unlinked._id }, { $set: { 'oauth.google': { id: 'google-sub-3', email: 'invitee@example.com', linkedAt: new Date() } } });
    const result = await invitationService.accept(token, String(unlinked._id), 'google');
    expect(result.role).toBe('member');
    expect((await m.Invitation.findById(invitation._id).lean()).acceptedVia).toBe('google');
  });

  // ---------------------------------------------------------------------------
  // Inviter exit
  // ---------------------------------------------------------------------------

  it('removing the inviter revokes their pending invitations (only theirs) and the accept is refused', async () => {
    const { invitation, token } = await send();
    const { invitation: ownersInvitation } = await send({ inviterId: ownerId, email: 'other@example.com' });

    const { revokedInvitations } = await orgMembersService.removeMember(orgId, adminId, OWNER_ACTOR);

    expect(revokedInvitations.map((r: { invitationId: string }) => r.invitationId)).toEqual([String(invitation._id)]);
    expect((await m.Invitation.findById(invitation._id).lean()).status).toBe('revoked');
    expect((await m.Invitation.findById(ownersInvitation._id).lean()).status).toBe('pending');

    const invitee = await createUser('invitee');
    await expect(invitationService.accept(token, String(invitee._id))).rejects.toThrow('INV_REVOKED');
    expect(await membershipOf(String(invitee._id))).toBeNull();
  });

  it('deactivating the inviter revokes their pending invitations and the accept is refused', async () => {
    const { invitation, token } = await send();

    const { revokedInvitations } = await orgMembersService.deactivateMember(orgId, adminId, OWNER_ACTOR);
    expect(revokedInvitations).toHaveLength(1);
    expect((await m.Invitation.findById(invitation._id).lean()).status).toBe('revoked');

    const invitee = await createUser('invitee');
    await expect(invitationService.accept(token, String(invitee._id))).rejects.toThrow('INV_REVOKED');
    expect(await membershipOf(String(invitee._id))).toBeNull();
  });

  it('backstop: a still-pending invitation whose inviter left the org (no revoke ran) is refused at acceptance', async () => {
    const { invitation, token } = await send();
    // The inviter vanishes from the org WITHOUT the member-exit path (e.g. a
    // direct data change / an exit path predating the revoke).
    await m.UserOrganization.deleteOne({ userId: adminId, organizationId: orgId });
    await m.RoleAssignment.deleteMany({ userId: adminId, organizationId: orgId });
    expect((await m.Invitation.findById(invitation._id).lean()).status).toBe('pending');

    const invitee = await createUser('invitee');
    await expect(invitationService.accept(token, String(invitee._id))).rejects.toThrow('INV_REVOKED');
    expect(await membershipOf(String(invitee._id))).toBeNull();
    // Rolled back with the transaction: the row is untouched, not half-accepted.
    expect((await m.Invitation.findById(invitation._id).lean()).status).toBe('pending');
  });

  it('an inviter stripped of invitations:manage (still a member) no longer vouches for their invitation', async () => {
    // A non-admin delegate holding only the People Manager Role sends...
    const delegate = await createUser('delegate');
    await m.UserOrganization.create({ userId: delegate._id, organizationId: orgId, role: 'member', isActive: true });
    await roles.ensureBaselineRole(delegate._id, orgId);
    await m.RoleAssignment.create({ userId: delegate._id, roleId: inviterRoleId, organizationId: orgId });
    const { token } = await send({ inviterId: String(delegate._id), inviterIsAdmin: false });

    // ...then loses the Role.
    await m.RoleAssignment.deleteOne({ userId: delegate._id, roleId: inviterRoleId });

    const invitee = await createUser('invitee');
    await expect(invitationService.accept(token, String(invitee._id))).rejects.toThrow('INV_REVOKED');
    expect(await membershipOf(String(invitee._id))).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Seats
  // ---------------------------------------------------------------------------

  it('a pending invitation reserves a seat: the send is refused at the cap', async () => {
    // owner + admin occupy 2 seats.
    await m.Organization.updateOne({ _id: orgId }, { $set: { 'quotas.seats': 3 } });
    await send({ email: 'first@example.com' });
    expect((await seats.pooledSeatUsage(orgId)).used).toBe(3);

    await expect(send({ email: 'second@example.com' })).rejects.toThrow('INV_SEAT_LIMIT');
    expect(await m.Invitation.countDocuments({ organizationId: orgId })).toBe(1);
  });

  it('accept at exactly the cap succeeds — the reservation becomes the seat, usage unchanged', async () => {
    await m.Organization.updateOne({ _id: orgId }, { $set: { 'quotas.seats': 3 } });
    const { token } = await send();
    const invitee = await createUser('invitee');

    await invitationService.accept(token, String(invitee._id));
    expect(await seats.pooledSeatUsage(orgId)).toMatchObject({ limit: 3, used: 3 });
  });

  it('a cap lowered between send and accept refuses the accept and rolls the whole acceptance back', async () => {
    const { invitation, token } = await send({ roleIds: [securityRoleId] });
    // Billing downgrade: only the two existing humans fit now.
    await m.Organization.updateOne({ _id: orgId }, { $set: { 'quotas.seats': 2 } });
    const invitee = await createUser('invitee');

    await expect(invitationService.accept(token, String(invitee._id))).rejects.toThrow('INV_SEAT_LIMIT');

    // The post-write re-count ran AFTER membership, Roles and the status flip
    // were written — all three must be gone with the aborted transaction.
    expect(await membershipOf(String(invitee._id))).toBeNull();
    expect(await m.RoleAssignment.countDocuments({ userId: invitee._id })).toBe(0);
    expect((await m.Invitation.findById(invitation._id).lean()).status).toBe('pending');
    expect((await m.User.findById(invitee._id).lean()).lastActiveOrgId).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Role carry-over
  // ---------------------------------------------------------------------------

  it('send refuses an admin invitation from a non-admin delegate', async () => {
    await expect(send({ role: 'admin', inviterIsAdmin: false, inviterId: String((await createUser('d'))._id) }))
      .rejects.toThrow('INV_ADMIN_REQUIRES_ADMIN');
  });

  it('an admin invitation whose inviter was demoted joins as member, and Roles above the new ceiling are dropped', async () => {
    const { token } = await send({ role: 'admin', roleIds: [securityRoleId, inviterRoleId] });

    // Demote the admin to a People Manager: still may invite (invitations:manage)
    // but no longer an admin and does not hold `members:manage`.
    await m.UserOrganization.updateOne({ userId: adminId, organizationId: orgId }, { $set: { role: 'member' } });
    await m.RoleAssignment.deleteOne({ userId: adminId, roleId: await builtinRoleId('admin') });
    await m.RoleAssignment.create({ userId: adminId, roleId: inviterRoleId, organizationId: orgId });

    const invitee = await createUser('invitee');
    const result = await invitationService.accept(token, String(invitee._id));

    expect(result.role).toBe('member');
    expect(result.grantedRoleIds).toEqual([inviterRoleId]);
    expect(result.droppedRoleIds).toEqual([securityRoleId]);
    expect((await membershipOf(String(invitee._id))).role).toBe('member');
    const held = await roleIdsOf(String(invitee._id));
    expect(held).toEqual([await builtinRoleId('member'), inviterRoleId].sort());
    expect(held).not.toContain(await builtinRoleId('admin'));
    expect(held).not.toContain(securityRoleId);
  });

  it('an admin invitation sent by the org owner is accepted as admin with the built-in Admin Role', async () => {
    const { token } = await send({ inviterId: ownerId, role: 'admin' });
    const invitee = await createUser('invitee');
    const result = await invitationService.accept(token, String(invitee._id));
    expect(result.role).toBe('admin');
    expect(await roleIdsOf(String(invitee._id))).toContain(await builtinRoleId('admin'));
  });

  it('a Role deleted between send and accept is dropped, not fatal', async () => {
    const { token } = await send({ roleIds: [securityRoleId] });
    await m.Role.deleteOne({ _id: securityRoleId });
    const invitee = await createUser('invitee');

    const result = await invitationService.accept(token, String(invitee._id));
    expect(result.droppedRoleIds).toEqual([securityRoleId]);
    expect(await roleIdsOf(String(invitee._id))).toEqual([await builtinRoleId('member')]);
  });
  // ---------------------------------------------------------------------------
  // Token at rest: only its SHA-256 is stored; the plaintext is only in the link
  // ---------------------------------------------------------------------------

  const sha256 = async (s: string) => (await import('crypto')).createHash('sha256').update(s).digest('hex');
  const rawCollection = () => mongoose.connection.collection('invitations');
  const rawRow = (id: unknown) => rawCollection().findOne({ _id: id });

  it('create stores the SHA-256 of the emailed token, never the token itself', async () => {
    const { emailService } = await import('../src/utils/email.js');
    const spy = jest.spyOn(emailService, 'sendInvitation');
    try {
      const { invitation, token } = await send();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(spy.mock.calls[0][0]).toMatchObject({ invitationToken: token });
      const row = await rawRow(invitation._id);
      expect(row.tokenHash).toBe(await sha256(token));
      expect(row.token).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain(token);
    } finally {
      spy.mockRestore();
    }
  });

  it('lookup/preview finds the invitation by the plaintext token only (the stored hash is not a token)', async () => {
    const { invitation, token } = await send();
    expect(String((await invitationService.getByToken(token))._id)).toBe(String(invitation._id));
    const row = await rawRow(invitation._id);
    expect(await invitationService.getByToken(row.tokenHash)).toBeNull();
    await expect(invitationService.accept(row.tokenHash, ownerId)).rejects.toThrow('INV_NOT_FOUND');
  });

  it('lookup of an expired invitation records the expiry', async () => {
    const { invitation, token } = await send();
    await m.Invitation.updateOne({ _id: invitation._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const found = await invitationService.getByToken(token);
    expect(found.status).toBe('expired');
    expect((await rawRow(invitation._id)).status).toBe('expired');
  });

  it('a preview racing a resend does not expire the re-armed invitation', async () => {
    const { invitation, token } = await send();
    await m.Invitation.updateOne({ _id: invitation._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const rearmedUntil = new Date(Date.now() + 86_400_000);
    // The preview reads the lapsed row; a resend re-arms it before the preview
    // records the expiry.
    const original = m.Invitation.findOne.bind(m.Invitation);
    const spy = jest.spyOn(m.Invitation, 'findOne').mockImplementationOnce(((filter: unknown) => {
      const query = original(filter);
      const exec = query.exec.bind(query);
      query.exec = async () => {
        const doc = await exec();
        await rawCollection().updateOne({ _id: invitation._id }, { $set: { expiresAt: rearmedUntil, tokenHash: 'rearmed' } });
        return doc;
      };
      return query;
    }) as never);
    try {
      await invitationService.getByToken(token);
    } finally {
      spy.mockRestore();
    }
    expect((await rawRow(invitation._id)).status).toBe('pending');
  });

  it('resend rotates the token: the new emailed token is accepted, the old link is dead', async () => {
    const { emailService } = await import('../src/utils/email.js');
    const { invitation, token: oldToken } = await send();
    const spy = jest.spyOn(emailService, 'sendInvitation');
    let newToken: string;
    try {
      await invitationService.resend(String(invitation._id), orgId, ownerId, true);
      newToken = (spy.mock.calls[0][0] as { invitationToken: string }).invitationToken;
    } finally {
      spy.mockRestore();
    }
    expect(newToken).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken).not.toBe(oldToken);
    const row = await rawRow(invitation._id);
    expect(row.tokenHash).toBe(await sha256(newToken));
    expect(await invitationService.getByToken(oldToken)).toBeNull();

    const invitee = await createUser('invitee');
    await expect(invitationService.accept(oldToken, String(invitee._id))).rejects.toThrow('INV_NOT_FOUND');
    const result = await invitationService.accept(newToken, String(invitee._id));
    expect(result.invitationId).toBe(String(invitation._id));
  });

  it('revoke by id: the token then answers INV_REVOKED', async () => {
    const { invitation, token } = await send();
    await invitationService.revoke(String(invitation._id), orgId, ownerId, true);
    const invitee = await createUser('invitee');
    await expect(invitationService.accept(token, String(invitee._id))).rejects.toThrow('INV_REVOKED');
    expect((await invitationService.getByToken(token)).status).toBe('revoked');
  });

  it('the org listing carries neither the token nor its hash', async () => {
    await send();
    const { invitations } = await invitationService.listForOrg(orgId, { offset: 0, limit: 10 });
    expect(invitations).toHaveLength(1);
    expect(invitations[0]).not.toHaveProperty('tokenHash');
    expect(invitations[0]).not.toHaveProperty('token');
  });
});
