// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo check that a NEW session re-checks inherited team entry.
 *
 * A parent org's admin who once switched into a team through inherited
 * (ancestor-admin) authority has that team as `lastActiveOrgId`. Sign-in pins
 * it without switching, so it must re-ask the question switch-org asks —
 * `team_access:open` in the ancestor — and land in the ancestor (moving
 * `lastActiveOrgId` there) when the answer is now no. A direct membership, a
 * still-granted permission, and renewing an existing session are unaffected.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1, like the siblings.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { Registry } from 'prom-client';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('sign-in into an inherited team (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, token: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    token = {
      ...(await import('../src/services/session/access-tokens.js')),
      ...(await import('../src/services/session/refresh-sessions.js')),
      ...(await import('../src/utils/token.js')),
    };
    (await import('./helpers/signing.js')).installTestSigningKeys();
    (await import('../src/observability/metrics.js')).setMetricsRegistry(new Registry());
  }, 120_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  let userId: string;
  let rootId: string;
  let teamId: string;
  let roleId: string;

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Organization, m.Role, m.RoleAssignment]) await model.deleteMany({});
    const owner = new mongoose.Types.ObjectId();
    const root = await m.Organization.create({ name: 'Root', owner, tier: 'team' });
    const team = await m.Organization.create({ name: 'Team', owner, tier: 'team', parentOrgId: String(root._id) });
    rootId = String(root._id); teamId = String(team._id);
    // An admin of the ROOT only — no membership row in the team — whose last
    // session was in the team.
    const user = await m.User.create({ username: 'parent-admin', email: 'admin@example.com', isEmailVerified: true, lastActiveOrgId: team._id });
    userId = String(user._id);
    await m.UserOrganization.create({ userId: user._id, organizationId: root._id, role: 'admin', isActive: true });
    const role = await m.Role.create({ organizationId: root._id, name: 'Team opener', permissions: ['team_access:open'] });
    roleId = String(role._id);
  });

  const loadUser = () => m.User.findById(userId).select('+tokenVersion +isSuperAdmin');
  const login = () => ({ kind: 'interactive' as const, auth: token.signInAuth('pwd') });
  const orgOf = (t: { accessToken: string }) => token.verifyAccessToken(t.accessToken).organizationId;
  const lastActive = async () => String((await m.User.findById(userId).lean()).lastActiveOrgId);
  const grantOpen = () => m.RoleAssignment.create({ userId, roleId, organizationId: rootId });

  it('lands in the team while the ancestor still grants team_access:open', async () => {
    await grantOpen();
    const tokens = await token.issueTokens(await loadUser(), undefined, login());
    expect(orgOf(tokens)).toBe(teamId);
    expect(await lastActive()).toBe(teamId);
  });

  it('lands in the ancestor and moves lastActiveOrgId there once it no longer does', async () => {
    const tokens = await token.issueTokens(await loadUser(), undefined, login());
    expect(orgOf(tokens)).toBe(rootId);
    expect(await lastActive()).toBe(rootId);
  });

  it('applies to an explicitly requested team too (the same act of entering)', async () => {
    const tokens = await token.issueTokens(await loadUser(), teamId, login());
    expect(orgOf(tokens)).toBe(rootId);
  });

  it('does not touch a DIRECT team membership', async () => {
    await m.UserOrganization.create({ userId, organizationId: teamId, role: 'admin', isActive: true });
    const tokens = await token.issueTokens(await loadUser(), undefined, login());
    expect(orgOf(tokens)).toBe(teamId);
    expect(await lastActive()).toBe(teamId);
  });

  it('a superadmin holds every permission, so it still lands in the team', async () => {
    await m.User.updateOne({ _id: userId }, { $set: { isSuperAdmin: true } });
    const tokens = await token.issueTokens(await loadUser(), undefined, login());
    expect(orgOf(tokens)).toBe(teamId);
  });

  it('does not re-gate renewing a session that already entered the team', async () => {
    await grantOpen();
    const tokens = await token.issueTokens(await loadUser(), undefined, login());
    expect(orgOf(tokens)).toBe(teamId);
    await m.RoleAssignment.deleteMany({});
    const sessionId = token.verifyAccessToken(tokens.accessToken).sid;
    const renewed = await token.renewSessionTokens(await loadUser(), teamId, { sessionId });
    expect(renewed && orgOf(renewed)).toBe(teamId);
  });
});
