// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// In-memory Organization model (parent chain) for the quota hierarchy helpers.
jest.unstable_mockModule('../src/models/organization.js', () => {
  type Row = { _id: string; parentOrgId: string | null; deletedAt?: Date | null };
  const orgs = new Map<string, Row>();
  // Honours the `deletedAt: null` filter the helpers put on child lookups.
  const live = (o: Row, q: { deletedAt?: unknown }) => !('deletedAt' in q) || !o.deletedAt;
  const Organization = {
    __set(list: Row[]) {
      orgs.clear();
      for (const o of list) orgs.set(o._id, o);
    },
    findById(id: unknown) {
      return { select: () => ({ lean: async () => orgs.get(String(id)) ?? null }) };
    },
    find(query: { parentOrgId?: { $in?: unknown[] }; deletedAt?: unknown; $or?: Array<{ _id?: unknown; parentOrgId?: unknown; deletedAt?: unknown }> }) {
      if (query.$or) {
        // Self-or-children lookup (findOrgWithHierarchy).
        const selfId = String(query.$or[0]._id);
        const childQ = query.$or[1];
        const parent = String(childQ.parentOrgId);
        return {
          select: () => ({
            lean: async () => [...orgs.values()].filter(o => o._id === selfId || (o.parentOrgId === parent && live(o, childQ))),
          }),
        };
      }
      const set = new Set((query.parentOrgId?.$in ?? []).map(String));
      return {
        select: () => ({
          lean: async () => [...orgs.values()].filter(o => o.parentOrgId && set.has(String(o.parentOrgId)) && live(o, query)),
        }),
      };
    },
  };
  return { Organization };
});

const { resolveRootOrgId, expandOrgScope, findOrgWithHierarchy } = await import('../src/helpers/org-hierarchy.js');
const { Organization } = await import('../src/models/organization.js') as unknown as {
  Organization: {
    __set(list: Array<{ _id: string; parentOrgId: string | null; deletedAt?: Date | null }>): void;
  };
};

// root ──┬── teamA ── subA
//        └── teamB
beforeEach(() => {
  Organization.__set([
    { _id: 'root', parentOrgId: null },
    { _id: 'teamA', parentOrgId: 'root' },
    { _id: 'teamB', parentOrgId: 'root' },
    { _id: 'subA', parentOrgId: 'teamA' },
  ]);
});

describe('quota org-hierarchy: resolveRootOrgId', () => {
  it('returns self for a root org', async () => {
    expect(await resolveRootOrgId('root')).toBe('root');
  });
  it('walks a team up to the root', async () => {
    expect(await resolveRootOrgId('teamA')).toBe('root');
  });
  it('walks a nested team up to the root', async () => {
    expect(await resolveRootOrgId('subA')).toBe('root');
  });
  it('returns the input for an unknown org', async () => {
    expect(await resolveRootOrgId('ghost')).toBe('ghost');
  });
  it('terminates on a cycle', async () => {
    Organization.__set([
      { _id: 'x', parentOrgId: 'y' },
      { _id: 'y', parentOrgId: 'x' },
    ]);
    expect(['x', 'y']).toContain(await resolveRootOrgId('x'));
  });
});

describe('quota org-hierarchy: expandOrgScope', () => {
  it('expands the root to the whole subtree', async () => {
    expect(new Set(await expandOrgScope('root'))).toEqual(new Set(['root', 'teamA', 'teamB', 'subA']));
  });
  it('returns [self] for a leaf org (flat — triggers no shared cap)', async () => {
    expect(await expandOrgScope('subA')).toEqual(['subA']);
  });
});

describe('quota org-hierarchy: findOrgWithHierarchy (single self-or-children query)', () => {
  it('root with teams: self row, no parent, has children', async () => {
    const r = await findOrgWithHierarchy<{ _id: string }>('root', '');
    expect(r.self?._id).toBe('root');
    expect(r.parentOrgId).toBeUndefined();
    expect(r.hasChildren).toBe(true);
  });
  it('team: self row + its parent', async () => {
    const r = await findOrgWithHierarchy<{ _id: string }>('teamB', '');
    expect(r.self?._id).toBe('teamB');
    expect(r.parentOrgId).toBe('root');
    expect(r.hasChildren).toBe(false);
  });
  it('flat org: self only', async () => {
    Organization.__set([{ _id: 'solo', parentOrgId: null }]);
    const r = await findOrgWithHierarchy<{ _id: string }>('solo', '');
    expect(r).toEqual({ self: { _id: 'solo', parentOrgId: null }, parentOrgId: undefined, hasChildren: false });
  });
  it('a root whose only team is soft-deleted is flat (the team left the pool)', async () => {
    Organization.__set([
      { _id: 'root', parentOrgId: null },
      { _id: 'gone', parentOrgId: 'root', deletedAt: new Date() },
    ]);
    const r = await findOrgWithHierarchy<{ _id: string }>('root', '');
    expect(r.hasChildren).toBe(false);
    await expect(expandOrgScope('root')).resolves.toEqual(['root']);
  });
  it('unknown org: null self, flat', async () => {
    const r = await findOrgWithHierarchy('ghost', '');
    expect(r.self).toBeNull();
    expect(r.hasChildren).toBe(false);
  });
});
