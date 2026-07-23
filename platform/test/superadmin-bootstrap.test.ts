// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for BOOTSTRAP_SUPERADMIN_EMAILS auto-promote at platform startup.
 *
 * The promotion is routed through `grantPlatformAdmin` (roles-service) — which
 * assigns the system-org Super Admin Role AND bumps `tokenVersion` — instead of a
 * bare `isSuperAdmin=true` write. That keeps the flag from being silently cleared
 * by a later `recomputeUserOrgRole` and takes effect without a re-login. These
 * tests assert the bootstrap drives that service (never a direct flag write),
 * audits genuine flips, and stays non-fatal on a per-user grant failure.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockUpdateMany = jest.fn();
const mockUpdateOne = jest.fn();
const mockFind = jest.fn();
const mockGrant = jest.fn<(userId: string) => Promise<{ changed: boolean }>>();
const mockAuditCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {
    updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

// The Super Admin Role grant is delegated to roles-service; mock it so the
// bootstrap's orchestration (per-user grant, audit on a real change) is what's
// under test — not the transactional Role assignment itself.
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  grantPlatformAdmin: (...args: [string]) => mockGrant(...args),
}));

jest.unstable_mockModule('../src/models/audit-event.js', () => ({
  __esModule: true,
  // `auditService.createEvent` now delegates to the tamper-evidence chain
  // append, which reads the chain tail via `findOne(...).sort().select().lean()`
  // before creating the row. An empty tail → these first grants get prevHash null.
  default: {
    create: (...args: unknown[]) => mockAuditCreate(...args),
    findOne: () => ({ sort: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) }),
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { bootstrapSuperAdmins, maybePromoteNewUser } = await import('../src/services/superadmin-bootstrap.js');

/** Flush pending microtasks so the fire-and-forget, per-chain-serialized audit
 *  appends (tail lookup + create) settle before asserting on them. */
const flush = () => new Promise((r) => setImmediate(r));

/** `User.find(...).select(...).lean()` → the given rows. */
const findsUsers = (rows: unknown[]) =>
  mockFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(rows) }) });

const ORIGINAL = process.env.BOOTSTRAP_SUPERADMIN_EMAILS;

function setEnv(value: string | undefined) {
  if (value === undefined) delete process.env.BOOTSTRAP_SUPERADMIN_EMAILS;
  else process.env.BOOTSTRAP_SUPERADMIN_EMAILS = value;
}

beforeEach(() => {
  mockUpdateMany.mockReset();
  mockUpdateOne.mockReset();
  mockFind.mockReset();
  mockGrant.mockReset();
  mockAuditCreate.mockReset();
  mockAuditCreate.mockResolvedValue(undefined);
  // Default: no existing users found (everything is "missing")
  findsUsers([]);
  // Default: every grant is a genuine flip.
  mockGrant.mockResolvedValue({ changed: true });
});

afterAll(() => {
  setEnv(ORIGINAL);
});

describe('bootstrapSuperAdmins', () => {
  it('is a no-op when env is unset', async () => {
    setEnv(undefined);
    const count = await bootstrapSuperAdmins();
    expect(count).toBe(0);
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('is a no-op when env is empty string', async () => {
    setEnv('');
    const count = await bootstrapSuperAdmins();
    expect(count).toBe(0);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  it('promotes a single email via grantPlatformAdmin (NOT a bare flag write)', async () => {
    setEnv('alice@example.com');
    findsUsers([{ _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: false }]);

    const count = await bootstrapSuperAdmins();

    expect(count).toBe(1);
    // The grant goes through the Super Admin Role service (assigns Role + bumps
    // tokenVersion), never a direct `isSuperAdmin=true` write.
    expect(mockGrant).toHaveBeenCalledWith('u-alice');
    expect(mockUpdateMany).not.toHaveBeenCalled();
    // The pre-read still targets the listed emails.
    expect(mockFind).toHaveBeenCalledWith({ email: { $in: ['alice@example.com'] } });
  });

  it('splits and normalizes a comma-separated list (trim + lowercase), granting each', async () => {
    setEnv('  Alice@Example.com , bob@example.com,  CHARLIE@example.com  ');
    findsUsers([
      { _id: { toString: () => 'u-a' }, email: 'alice@example.com', isSuperAdmin: false },
      { _id: { toString: () => 'u-b' }, email: 'bob@example.com', isSuperAdmin: false },
      { _id: { toString: () => 'u-c' }, email: 'charlie@example.com', isSuperAdmin: false },
    ]);

    const count = await bootstrapSuperAdmins();

    expect(count).toBe(3);
    expect(mockFind).toHaveBeenCalledWith({
      email: { $in: ['alice@example.com', 'bob@example.com', 'charlie@example.com'] },
    });
    expect(mockGrant).toHaveBeenCalledWith('u-a');
    expect(mockGrant).toHaveBeenCalledWith('u-b');
    expect(mockGrant).toHaveBeenCalledWith('u-c');
  });

  it('returns 0 (and audits nothing) when every listed user is already a sysadmin (warm boot)', async () => {
    setEnv('alice@example.com');
    // Self-healing grant is invoked but reports no change — the user already holds
    // the Super Admin Role, so nothing flips.
    mockGrant.mockResolvedValue({ changed: false });
    findsUsers([{ _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: true }]);

    const count = await bootstrapSuperAdmins();
    expect(count).toBe(0);
    expect(mockGrant).toHaveBeenCalledWith('u-alice'); // still invoked (heals a legacy flag-only row)
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('logs a warning (does not throw) when a listed email has no matching account', async () => {
    setEnv('alice@example.com,nonexistent@example.com');
    findsUsers([{ _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: false }]);

    // Should resolve cleanly. The "missing" set is logged but not thrown —
    // the registered-later flow auto-promotes on next boot.
    const count = await bootstrapSuperAdmins();
    expect(count).toBe(1);
    expect(mockGrant).toHaveBeenCalledTimes(1);
  });

  it('drops empty entries from a malformed list ("a,,,b")', async () => {
    setEnv('alice@example.com,,,bob@example.com');
    findsUsers([
      { _id: { toString: () => 'u-a' }, email: 'alice@example.com', isSuperAdmin: false },
      { _id: { toString: () => 'u-b' }, email: 'bob@example.com', isSuperAdmin: false },
    ]);

    await bootstrapSuperAdmins();
    expect(mockFind).toHaveBeenCalledWith({ email: { $in: ['alice@example.com', 'bob@example.com'] } });
    expect(mockGrant).toHaveBeenCalledTimes(2);
  });

  it('emits an admin.superadmin.grant audit event per newly-promoted user', async () => {
    setEnv('alice@example.com,bob@example.com');
    findsUsers([
      { _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: false },
      { _id: { toString: () => 'u-bob' }, email: 'bob@example.com', isSuperAdmin: false },
    ]);

    await bootstrapSuperAdmins();
    await flush();

    expect(mockAuditCreate).toHaveBeenCalledTimes(2);
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.superadmin.grant',
      actorId: 'bootstrap-env',
      targetType: 'user',
      targetId: 'u-alice',
      details: { email: 'alice@example.com', source: 'BOOTSTRAP_SUPERADMIN_EMAILS' },
    }));
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.superadmin.grant',
      actorId: 'bootstrap-env',
      targetId: 'u-bob',
    }));
  });

  it('audits only the users the grant actually flipped (changed:true)', async () => {
    setEnv('alice@example.com,bob@example.com');
    // bob already holds the Role → grant reports no change → no audit for bob.
    mockGrant.mockImplementation(async (userId: string) => ({ changed: userId === 'u-alice' }));
    findsUsers([
      { _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: false },
      { _id: { toString: () => 'u-bob' }, email: 'bob@example.com', isSuperAdmin: true },
    ]);

    const count = await bootstrapSuperAdmins();
    await flush();

    expect(count).toBe(1);
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'u-alice' }));
  });

  it('keeps promoting the rest when one user grant throws (non-fatal per user)', async () => {
    setEnv('alice@example.com,bob@example.com');
    mockGrant.mockImplementation(async (userId: string) => {
      if (userId === 'u-alice') throw new Error('RL_SUPERADMIN_ROLE_MISSING');
      return { changed: true };
    });
    findsUsers([
      { _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: false },
      { _id: { toString: () => 'u-bob' }, email: 'bob@example.com', isSuperAdmin: false },
    ]);

    const count = await bootstrapSuperAdmins();
    expect(count).toBe(1); // only bob flipped; alice's failure was swallowed + logged
    expect(mockGrant).toHaveBeenCalledTimes(2);
  });

  it('does not throw when the audit insert itself fails (fire-and-forget)', async () => {
    setEnv('alice@example.com');
    findsUsers([{ _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: false }]);
    mockAuditCreate.mockRejectedValueOnce(new Error('audit collection down'));

    // The whole bootstrap should still resolve successfully — audit failure
    // must not block HTTP from coming up.
    await expect(bootstrapSuperAdmins()).resolves.toBe(1);
  });
});

describe('maybePromoteNewUser', () => {
  it('is a no-op (no grant) when the email is not in the bootstrap list', async () => {
    setEnv('alice@example.com');
    const promoted = await maybePromoteNewUser('u-bob', 'bob@example.com');
    expect(promoted).toBe(false);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  it('is a no-op when the env is unset', async () => {
    setEnv(undefined);
    const promoted = await maybePromoteNewUser('u-alice', 'alice@example.com');
    expect(promoted).toBe(false);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  it('grants via grantPlatformAdmin (not a bare flag write) and audits on a real change', async () => {
    setEnv('alice@example.com');
    mockGrant.mockResolvedValue({ changed: true });

    const promoted = await maybePromoteNewUser('u-alice', 'Alice@Example.com');
    await flush();

    expect(promoted).toBe(true);
    expect(mockGrant).toHaveBeenCalledWith('u-alice');
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.superadmin.grant',
      actorId: 'bootstrap-env',
      targetId: 'u-alice',
      details: expect.objectContaining({ trigger: 'registration' }),
    }));
  });

  it('returns false (no audit) when the grant reports no change (already a sysadmin)', async () => {
    setEnv('alice@example.com');
    mockGrant.mockResolvedValue({ changed: false });

    const promoted = await maybePromoteNewUser('u-alice', 'alice@example.com');
    await flush();

    expect(promoted).toBe(false);
    expect(mockGrant).toHaveBeenCalledWith('u-alice');
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});
