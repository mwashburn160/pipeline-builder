// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for BOOTSTRAP_SUPERADMIN_EMAILS auto-promote at platform startup.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockUpdateMany = jest.fn();
const mockFind = jest.fn();
const mockAuditCreate = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {
    updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

jest.unstable_mockModule('../src/models/audit-event.js', () => ({
  __esModule: true,
  default: { create: (...args: unknown[]) => mockAuditCreate(...args) },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { bootstrapSuperAdmins } = await import('../src/services/superadmin-bootstrap.js');


const ORIGINAL = process.env.BOOTSTRAP_SUPERADMIN_EMAILS;

function setEnv(value: string | undefined) {
  if (value === undefined) delete process.env.BOOTSTRAP_SUPERADMIN_EMAILS;
  else process.env.BOOTSTRAP_SUPERADMIN_EMAILS = value;
}

beforeEach(() => {
  mockUpdateMany.mockReset();
  mockFind.mockReset();
  mockAuditCreate.mockReset();
  mockAuditCreate.mockResolvedValue(undefined);
  // Default: no existing users found (everything is "missing")
  mockFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
  mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
});

afterAll(() => {
  setEnv(ORIGINAL);
});

describe('bootstrapSuperAdmins', () => {
  it('is a no-op when env is unset', async () => {
    setEnv(undefined);
    const count = await bootstrapSuperAdmins();
    expect(count).toBe(0);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('is a no-op when env is empty string', async () => {
    setEnv('');
    const count = await bootstrapSuperAdmins();
    expect(count).toBe(0);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('promotes a single email and reports the modified count', async () => {
    setEnv('alice@example.com');
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    mockFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([{ _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: false }]),
      }),
    });

    const count = await bootstrapSuperAdmins();

    expect(count).toBe(1);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      // Filter targets the listed emails AND skips already-promoted users
      // so warm boots don't churn a write per row.
      { email: { $in: ['alice@example.com'] }, isSuperAdmin: { $ne: true } },
      { $set: { isSuperAdmin: true } },
    );
  });

  it('splits and normalizes a comma-separated list (trim + lowercase)', async () => {
    setEnv('  Alice@Example.com , bob@example.com,  CHARLIE@example.com  ');
    mockUpdateMany.mockResolvedValue({ modifiedCount: 3 });
    mockFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([
          { _id: { toString: () => 'u-a' }, email: 'alice@example.com', isSuperAdmin: false },
          { _id: { toString: () => 'u-b' }, email: 'bob@example.com', isSuperAdmin: false },
          { _id: { toString: () => 'u-c' }, email: 'charlie@example.com', isSuperAdmin: false },
        ]),
      }),
    });

    await bootstrapSuperAdmins();

    expect(mockUpdateMany).toHaveBeenCalledWith(
      { email: { $in: ['alice@example.com', 'bob@example.com', 'charlie@example.com'] }, isSuperAdmin: { $ne: true } },
      { $set: { isSuperAdmin: true } },
    );
  });

  it('returns 0 modified when every listed user is already a sysadmin (warm boot)', async () => {
    setEnv('alice@example.com');
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockFind.mockReturnValue({
      select: () => ({
        // Already-sysadmin: pre-read sees isSuperAdmin=true, so no audit
        // grant fires and updateMany matches zero docs.
        lean: () => Promise.resolve([{ _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: true }]),
      }),
    });

    const count = await bootstrapSuperAdmins();
    expect(count).toBe(0);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('logs a warning (does not throw) when a listed email has no matching account', async () => {
    setEnv('alice@example.com,nonexistent@example.com');
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    mockFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([{ _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: false }]),
      }),
    });

    // Should resolve cleanly. The "missing" set is logged but not thrown —
    // the registered-later flow auto-promotes on next boot.
    const count = await bootstrapSuperAdmins();
    expect(count).toBe(1);
  });

  it('drops empty entries from a malformed list ("a,,,b")', async () => {
    setEnv('alice@example.com,,,bob@example.com');
    mockUpdateMany.mockResolvedValue({ modifiedCount: 2 });
    mockFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([
          { _id: { toString: () => 'u-a' }, email: 'alice@example.com', isSuperAdmin: false },
          { _id: { toString: () => 'u-b' }, email: 'bob@example.com', isSuperAdmin: false },
        ]),
      }),
    });

    await bootstrapSuperAdmins();
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { email: { $in: ['alice@example.com', 'bob@example.com'] }, isSuperAdmin: { $ne: true } },
      { $set: { isSuperAdmin: true } },
    );
  });

  it('emits an admin.superadmin.grant audit event per newly-promoted user', async () => {
    setEnv('alice@example.com,bob@example.com');
    mockUpdateMany.mockResolvedValue({ modifiedCount: 2 });
    mockFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([
          { _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: false },
          { _id: { toString: () => 'u-bob' }, email: 'bob@example.com', isSuperAdmin: false },
        ]),
      }),
    });

    await bootstrapSuperAdmins();

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

  it('skips audit events for users that were already sysadmins', async () => {
    setEnv('alice@example.com,bob@example.com');
    // Mongo's filter excludes already-promoted, so updateMany only modifies 1.
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    mockFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([
          { _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: false },
          { _id: { toString: () => 'u-bob' }, email: 'bob@example.com', isSuperAdmin: true },
        ]),
      }),
    });

    await bootstrapSuperAdmins();

    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'u-alice' }));
  });

  it('does not throw when the audit insert itself fails (fire-and-forget)', async () => {
    setEnv('alice@example.com');
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    mockFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([{ _id: { toString: () => 'u-alice' }, email: 'alice@example.com', isSuperAdmin: false }]),
      }),
    });
    mockAuditCreate.mockRejectedValueOnce(new Error('audit collection down'));

    // The whole bootstrap should still resolve successfully — audit failure
    // must not block HTTP from coming up.
    await expect(bootstrapSuperAdmins()).resolves.toBe(1);
  });
});
