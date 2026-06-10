// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// In-memory Organization model: a Map of id -> { _id, parentOrgId } with the
// minimal `findById(...).select(...).lean()` and `find(...).select(...).lean()`
// chains the resolver uses.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
jest.unstable_mockModule('../src/models/index.js', () => {
  const orgs = new Map<string, { _id: string; parentOrgId: string | null }>();
  const Organization = {
    __set(list: Array<{ _id: string; parentOrgId: string | null }>) {
      orgs.clear();
      for (const o of list) orgs.set(o._id, o);
    },
    findById(id: unknown) {
      return { select: () => ({ lean: async () => orgs.get(String(id)) ?? null }) };
    },
    find(query: { parentOrgId?: { $in?: unknown[] } }) {
      const set = new Set((query.parentOrgId?.$in ?? []).map(String));
      return {
        select: () => ({
          lean: async () => [...orgs.values()].filter(o => o.parentOrgId && set.has(String(o.parentOrgId))),
        }),
      };
    },
  };
  return { Organization };
});

const { resolveOrgLineage, expandOrgScope, isAncestorOrg } = await import('../src/helpers/org-hierarchy.js');

const { Organization } = (await import('../src/models/index.js')) as unknown as {
  Organization: { __set(list: Array<{ _id: string; parentOrgId: string | null }>): void };
};

// root ──┬── teamA ── subA
//        └── teamB
function seedTree() {
  Organization.__set([
    { _id: 'root', parentOrgId: null },
    { _id: 'teamA', parentOrgId: 'root' },
    { _id: 'teamB', parentOrgId: 'root' },
    { _id: 'subA', parentOrgId: 'teamA' },
  ]);
}

describe('resolveOrgLineage (walk up)', () => {
  beforeEach(seedTree);

  it('returns root=self and no parent for a flat/root org', async () => {
    expect(await resolveOrgLineage('root')).toEqual({ rootOrgId: 'root' });
  });

  it('returns the direct parent and root for a first-level team', async () => {
    expect(await resolveOrgLineage('teamA')).toEqual({ parentOrgId: 'root', rootOrgId: 'root' });
  });

  it('walks multiple levels up to the root', async () => {
    expect(await resolveOrgLineage('subA')).toEqual({ parentOrgId: 'teamA', rootOrgId: 'root' });
  });

  it('treats an unknown org as its own root', async () => {
    expect(await resolveOrgLineage('ghost')).toEqual({ rootOrgId: 'ghost' });
  });

  it('terminates on a cycle instead of looping forever', async () => {
    Organization.__set([
      { _id: 'x', parentOrgId: 'y' },
      { _id: 'y', parentOrgId: 'x' },
    ]);
    const lineage = await resolveOrgLineage('x');
    // Parent is y; the walk stops when it revisits x — no infinite loop.
    expect(lineage.parentOrgId).toBe('y');
    expect(['x', 'y']).toContain(lineage.rootOrgId);
  });
});

describe('expandOrgScope (walk down)', () => {
  beforeEach(seedTree);

  it('expands a root to itself plus all descendants (BFS)', async () => {
    const scope = await expandOrgScope('root');
    expect(scope[0]).toBe('root');
    expect(new Set(scope)).toEqual(new Set(['root', 'teamA', 'teamB', 'subA']));
  });

  it('expands a mid-level team to itself plus its subtree', async () => {
    expect(await expandOrgScope('teamA')).toEqual(['teamA', 'subA']);
  });

  it('returns just self for a leaf org', async () => {
    expect(await expandOrgScope('subA')).toEqual(['subA']);
  });

  it('returns just self when the org has no children', async () => {
    Organization.__set([{ _id: 'solo', parentOrgId: null }]);
    expect(await expandOrgScope('solo')).toEqual(['solo']);
  });
});

describe('isAncestorOrg', () => {
  beforeEach(seedTree);

  it('is true for a direct parent', async () => {
    expect(await isAncestorOrg('root', 'teamA')).toBe(true);
  });

  it('is true for a transitive ancestor', async () => {
    expect(await isAncestorOrg('root', 'subA')).toBe(true);
  });

  it('is false for the same org (not its own ancestor)', async () => {
    expect(await isAncestorOrg('root', 'root')).toBe(false);
  });

  it('is false for a sibling / unrelated org', async () => {
    expect(await isAncestorOrg('teamA', 'teamB')).toBe(false);
  });

  it('is false in the wrong direction (descendant is not an ancestor)', async () => {
    expect(await isAncestorOrg('subA', 'root')).toBe(false);
  });

  it('is false for flat/unrelated orgs', async () => {
    Organization.__set([
      { _id: 'a', parentOrgId: null },
      { _id: 'b', parentOrgId: null },
    ]);
    expect(await isAncestorOrg('a', 'b')).toBe(false);
  });
});
