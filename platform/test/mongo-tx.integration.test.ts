// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * withMongoTransaction against a REAL replica set, with the transaction forced
 * to RETRY — the case unit mocks can only imitate.
 *
 * The driver's `session.withTransaction` re-runs the whole body when the body
 * (or the commit) fails with a `TransientTransactionError`. It knows nothing
 * of mongoose document state: a document saved in the aborted attempt is
 * marked "already saved", so a re-run `doc.save({ session })` writes nothing
 * while the body's query-level writes re-apply — a commit missing half the
 * body. Proven here:
 *
 *  - control: the bare driver API loses a pre-loaded document's edit on retry;
 *  - the helper (mongoose `connection.transaction`) resets document state when
 *    the body throws, so the same body commits completely — for an edited
 *    pre-loaded document AND for a new document built outside the body;
 *  - the services fixed to be idempotent (`updateRole`, `setTier`) commit
 *    their whole state when the server fails the body's first write, and when
 *    it fails the COMMIT (the retry path mongoose does not reset for) — both
 *    driven by the server's `failCommand` failpoint.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default).
 */

import { it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('withMongoTransaction retries (real Mongo replica set)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, withMongoTransaction: any, updateRole: any, setTier: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  /** Commands the server failed, by name — proves the failpoint really fired. */
  const failed: string[] = [];

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({
      binary: { version: MONGOD_VERSION },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      // `configureFailPoint` is a test command.
      instanceOpts: [{ args: ['--setParameter', 'enableTestCommands=1'] }],
    });
    process.env.MONGODB_URI = replSet.getUri();
    await mongoose.connect(process.env.MONGODB_URI, { monitorCommands: true });
    mongoose.connection.getClient().on('commandFailed', (e: { commandName: string }) => failed.push(e.commandName));
    m = await import('../src/models/index.js');
    for (const model of [m.Organization, m.User, m.UserOrganization, m.Role, m.RoleAssignment]) await model.init();
    ({ withMongoTransaction } = await import('../src/utils/mongo-tx.js'));
    ({ updateRole } = await import('../src/services/role-crud.js'));
    ({ setTier } = await import('../src/services/organization-quota.js'));
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  beforeEach(async () => {
    failed.length = 0;
    for (const model of [m.Organization, m.User, m.UserOrganization, m.Role, m.RoleAssignment]) await model.deleteMany({});
  });

  afterEach(async () => {
    await failPoint('off');
  });

  /** Arm (or clear) the server's `failCommand` failpoint. */
  async function failPoint(mode: 'off' | { times: number }, data?: Record<string, unknown>): Promise<void> {
    await mongoose.connection.db.admin().command({ configureFailPoint: 'failCommand', mode, ...(data ? { data } : {}) });
  }

  /** The failure the server raises for a transaction write conflict. */
  function transientError(): Error {
    return new mongoose.mongo.MongoServerError({
      message: 'simulated write conflict',
      code: 112,
      codeName: 'WriteConflict',
      errorLabels: ['TransientTransactionError'],
    });
  }

  const newUser = (username: string) => new m.User({ username, email: `${username}@example.com`, isEmailVerified: true });
  const claimsVersionOf = async (id: unknown) =>
    ((await m.User.findById(id).select('+claimsVersion').lean()) as { claimsVersion?: number }).claimsVersion ?? 0;

  /**
   * A body that edits a document loaded BEFORE the transaction, saves it, and
   * makes a query-level write — failing transiently after both on attempt 1.
   */
  function preloadedEditBody(role: { name: string; save: (o: unknown) => Promise<unknown> }, userId: unknown) {
    let attempt = 0;
    const body = async (session: unknown) => {
      attempt += 1;
      role.name = 'Renamed';
      await role.save({ session });
      await m.User.updateOne({ _id: userId }, { $inc: { claimsVersion: 1 } }, { session });
      if (attempt === 1) throw transientError();
      return attempt;
    };
    return { body, attempts: () => attempt };
  }

  it('control: the bare driver withTransaction drops a pre-loaded document edit on retry', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const user = await newUser('ctl').save();
    await m.Role.create({ organizationId: orgId, name: 'Original', permissions: [] });
    const role = await m.Role.findOne({ organizationId: orgId });
    const { body, attempts } = preloadedEditBody(role, user._id);

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => body(session));
    } finally {
      await session.endSession();
    }

    expect(attempts()).toBe(2);
    // The query write committed; the document edit did NOT — the partial commit.
    expect(await claimsVersionOf(user._id)).toBe(1);
    expect((await m.Role.findById(role._id).lean()).name).toBe('Original');
  });

  it('the helper re-applies a pre-loaded document edit on retry — the commit is complete', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const user = await newUser('helper').save();
    await m.Role.create({ organizationId: orgId, name: 'Original', permissions: [] });
    const role = await m.Role.findOne({ organizationId: orgId });
    const { body, attempts } = preloadedEditBody(role, user._id);

    await expect(withMongoTransaction(body)).resolves.toBe(2);

    expect(attempts()).toBe(2);
    expect(await claimsVersionOf(user._id)).toBe(1);
    expect((await m.Role.findById(role._id).lean()).name).toBe('Renamed');
  });

  it('the helper re-inserts a NEW document built outside the body after a retry', async () => {
    const user = newUser('fresh');
    const orgId = new mongoose.Types.ObjectId();
    let attempt = 0;

    await withMongoTransaction(async (session: unknown) => {
      attempt += 1;
      await user.save({ session });
      await m.UserOrganization.create([{ userId: user._id, organizationId: orgId, role: 'member' }], { session });
      if (attempt === 1) throw transientError();
    });

    expect(attempt).toBe(2);
    expect(await m.User.countDocuments({ _id: user._id })).toBe(1);
    expect(await m.UserOrganization.countDocuments({ userId: user._id })).toBe(1);
  });

  it('a non-transient body error still aborts everything and propagates unchanged', async () => {
    const user = await newUser('abort').save();
    const boom = new Error('refused');

    await expect(withMongoTransaction(async (session: unknown) => {
      await m.User.updateOne({ _id: user._id }, { $inc: { claimsVersion: 1 } }, { session });
      throw boom;
    })).rejects.toBe(boom);

    expect(await claimsVersionOf(user._id)).toBe(0);
  });

  /** A custom Role with one assigned member, for `updateRole`. */
  async function seedRoleWithMember() {
    const orgId = new mongoose.Types.ObjectId();
    const member = await newUser(`member${Date.now()}`).save();
    const role = await m.Role.create({ organizationId: orgId, name: 'Deployers', permissions: ['pipelines:read'] });
    await m.RoleAssignment.create({ userId: member._id, roleId: role._id, organizationId: orgId });
    return { orgId, member, role };
  }
  const superAdmin = { permissions: [], isSuperAdmin: true, isOrgAdmin: false };

  it.each([
    ['the body\'s first write (update)', 'update'],
    ['the commit (no mongoose reset on this path)', 'commitTransaction'],
  ])('updateRole commits the Role edit AND the member claims bump when the server fails %s', async (_label, command) => {
    const { orgId, member, role } = await seedRoleWithMember();
    await failPoint({ times: 1 }, { failCommands: [command], errorCode: 112, errorLabels: ['TransientTransactionError'] });

    const out = await updateRole(String(orgId), String(role._id), { description: 'ships things', permissions: ['pipelines:write'] }, superAdmin);

    expect(failed).toContain(command);
    const stored = await m.Role.findById(role._id).lean();
    expect(stored.permissions).toEqual(['pipelines:write']);
    expect(stored.description).toBe('ships things');
    // Exactly once: the aborted attempt's bump rolled back.
    expect(await claimsVersionOf(member._id)).toBe(1);
    expect(out.bumpedMemberIds).toEqual([String(member._id)]);
  });

  it.each([
    ['the body\'s first write (update)', 'update'],
    ['the commit (no mongoose reset on this path)', 'commitTransaction'],
  ])('setTier commits the root tier AND its team propagation when the server fails %s', async (_label, command) => {
    const ownerId = new mongoose.Types.ObjectId();
    const root = await m.Organization.create({ name: 'Root Co', owner: ownerId, tier: 'team' });
    const team = await m.Organization.create({ name: 'Root Team', owner: ownerId, tier: 'team', parentOrgId: root._id });
    await failPoint({ times: 1 }, { failCommands: [command], errorCode: 112, errorLabels: ['TransientTransactionError'] });

    const out = await setTier(String(root._id), 'pro');

    expect(failed).toContain(command);
    expect(out).toEqual(expect.objectContaining({ previousTier: 'team', tier: 'pro' }));
    expect((await m.Organization.findById(root._id).lean()).tier).toBe('pro');
    expect((await m.Organization.findById(team._id).lean()).tier).toBe('pro');
  });
});
