// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// In-memory Organization model: a Map of id -> { _id, parentOrgId } with the
// minimal `findById(...).select(...).lean()` and `find(...).select(...).lean()`
// chains the resolver uses.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
jest.unstable_mockModule('../src/models/index.js', () => {
  type Row = { _id: string; parentOrgId: string | null; deletedAt?: Date | null; name?: string };
  const orgs = new Map<string, Row>();
  const Organization = {
    __set(list: Row[]) {
      orgs.clear();
      for (const o of list) orgs.set(o._id, o);
    },
    findById(id: unknown) {
      return { select: () => ({ lean: async () => orgs.get(String(id)) ?? null }) };
    },
    // Honors the `deletedAt: null` (live-only) filter the downward walk sends.
    find(query: { parentOrgId?: { $in?: unknown[] }; deletedAt?: null }) {
      const set = new Set((query.parentOrgId?.$in ?? []).map(String));
      const liveOnly = 'deletedAt' in query && query.deletedAt === null;
      return {
        select: () => ({
          lean: async () => [...orgs.values()].filter(o =>
            o.parentOrgId && set.has(String(o.parentOrgId)) && (!liveOnly || !o.deletedAt)),
        }),
      };
    },
    async exists(query: { parentOrgId: string }) {
      return [...orgs.values()].some(o => o.parentOrgId === query.parentOrgId) ? { _id: 'x' } : null;
    },
  };
  return { Organization };
});

const { resolveOrgLineage, expandOrgScope, isAncestorOrg, hasAnyChildOrg, getOrgName } = await import('../src/helpers/org-hierarchy.js');

const { Organization } = (await import('../src/models/index.js')) as unknown as {
  Organization: { __set(list: Array<{ _id: string; parentOrgId: string | null; deletedAt?: Date | null; name?: string }>): void };
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

describe('LIVE vs. ALL — soft-deleted teams', () => {
  beforeEach(() => {
    Organization.__set([
      { _id: 'root', parentOrgId: null, name: 'Root' },
      { _id: 'live', parentOrgId: 'root', name: 'Live team' },
      { _id: 'gone', parentOrgId: 'root', name: 'Gone team', deletedAt: new Date() },
    ]);
  });

  it('expandOrgScope (rollups, seats, propagation) excludes a soft-deleted team', async () => {
    expect(await expandOrgScope('root')).toEqual(['root', 'live']);
  });

  it('the upward walk still resolves a soft-deleted team through its parent (restore/export authz)', async () => {
    expect(await isAncestorOrg('root', 'gone')).toBe(true);
    expect(await resolveOrgLineage('gone')).toEqual({ parentOrgId: 'root', rootOrgId: 'root' });
  });

  it('hasAnyChildOrg sees soft-deleted children too', async () => {
    Organization.__set([
      { _id: 'root', parentOrgId: null },
      { _id: 'gone', parentOrgId: 'root', deletedAt: new Date() },
    ]);
    expect(await hasAnyChildOrg('root')).toBe(true);
    expect(await hasAnyChildOrg('gone')).toBe(false);
  });

  it('getOrgName resolves live and soft-deleted orgs; undefined for none', async () => {
    expect(await getOrgName('gone')).toBe('Gone team');
    expect(await getOrgName(null)).toBeUndefined();
    expect(await getOrgName('nope')).toBeUndefined();
  });
});
