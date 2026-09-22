// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * MANUAL vs MAPPED Role separation (`syncMappedRoles` in mapped-roles).
 *
 * The one invariant this function exists for: a sync owns only the assignments
 * IT created (`source: 'jit'`). A Role an admin granted by hand — including the
 * built-in Member floor, and including a Role that also happens to be mapped —
 * is never removed by a sync, no matter what the IdP stops saying.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const assignmentFind = jest.fn<(...a: unknown[]) => unknown>();
const assignmentUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const assignmentDeleteMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();

/** Chainable Mongoose query stub. */
function query(result: unknown) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.session = self; q.select = self;
  q.lean = async () => result;
  q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return q;
}

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('mongoose', () => ({
  default: { Types: { ObjectId: class {} } },
  Types: { ObjectId: class {} },
}));

jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));

jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishSessionSlotRevocation: async () => true,
  publishAccessKeyRevocation: async () => true,
  publishUserRevocation: jest.fn(async () => undefined),
  publishUsersRevocation: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Role: { find: jest.fn(), findOne: jest.fn(), create: jest.fn(), exists: jest.fn() },
  RoleAssignment: {
    find: (...a: unknown[]) => assignmentFind(...a),
    updateOne: (...a: unknown[]) => assignmentUpdateOne(...a),
    deleteMany: (...a: unknown[]) => assignmentDeleteMany(...a),
  },
  User: { updateOne: jest.fn(), updateMany: jest.fn(), findById: jest.fn(), findOne: jest.fn() },
  UserOrganization: { findOne: jest.fn() },
}));

const { syncMappedRoles } = await import('../src/services/mapped-roles.js');

const ORG = 'org-1';
const SESSION = { id: 'test-session' } as never;

beforeEach(() => {
  jest.clearAllMocks();
  assignmentUpdateOne.mockResolvedValue({});
  assignmentDeleteMany.mockResolvedValue({});
});

describe('syncMappedRoles', () => {
  it('adds a newly mapped Role, stamped as JIT-owned', async () => {
    assignmentFind.mockReturnValue(query([]));
    const out = await syncMappedRoles(ORG, 'u1', ['r1'], SESSION);

    expect(out).toEqual({ added: ['r1'], removed: [] });
    expect(assignmentUpdateOne).toHaveBeenCalledWith(
      { userId: 'u1', roleId: 'r1' },
      { $setOnInsert: { userId: 'u1', roleId: 'r1', organizationId: ORG, source: 'jit' } },
      { upsert: true, session: SESSION },
    );
  });

  it('removes a JIT-owned Role the mapping no longer names', async () => {
    assignmentFind.mockReturnValue(query([{ roleId: 'stale', source: 'jit' }]));
    const out = await syncMappedRoles(ORG, 'u1', [], SESSION);

    expect(out).toEqual({ added: [], removed: ['stale'] });
    expect(assignmentDeleteMany).toHaveBeenCalledWith(
      { userId: 'u1', organizationId: ORG, roleId: { $in: ['stale'] }, source: 'jit' },
      { session: SESSION },
    );
  });

  it('NEVER removes a manually assigned Role, even when unmapped', async () => {
    assignmentFind.mockReturnValue(query([{ roleId: 'hand-granted', source: 'manual' }]));
    const out = await syncMappedRoles(ORG, 'u1', [], SESSION);

    expect(out).toEqual({ added: [], removed: [] });
    expect(assignmentDeleteMany).not.toHaveBeenCalled();
  });

  it('treats an assignment with NO source (the Member floor) as manual', async () => {
    assignmentFind.mockReturnValue(query([{ roleId: 'legacy' }]));
    const out = await syncMappedRoles(ORG, 'u1', [], SESSION);

    expect(out.removed).toEqual([]);
    expect(assignmentDeleteMany).not.toHaveBeenCalled();
  });

  it('leaves a manual Role that is ALSO mapped untouched (no re-write, no demotion)', async () => {
    assignmentFind.mockReturnValue(query([{ roleId: 'r1', source: 'manual' }]));
    const out = await syncMappedRoles(ORG, 'u1', ['r1'], SESSION);

    expect(out).toEqual({ added: [], removed: [] });
    expect(assignmentUpdateOne).not.toHaveBeenCalled();
    expect(assignmentDeleteMany).not.toHaveBeenCalled();
  });

  it('adds and removes in the same sync, touching only JIT rows', async () => {
    assignmentFind.mockReturnValue(query([
      { roleId: 'keep-manual', source: 'manual' },
      { roleId: 'drop-jit', source: 'jit' },
    ]));
    const out = await syncMappedRoles(ORG, 'u1', ['new-jit'], SESSION);

    expect(out).toEqual({ added: ['new-jit'], removed: ['drop-jit'] });
    expect(assignmentDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: { $in: ['drop-jit'] }, source: 'jit' }),
      { session: SESSION },
    );
  });

  it('scopes every read and write to the one org', async () => {
    assignmentFind.mockReturnValue(query([]));
    await syncMappedRoles(ORG, 'u1', [], SESSION);
    expect(assignmentFind).toHaveBeenCalledWith({ userId: 'u1', organizationId: ORG });
  });
});
