// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// In-memory Organization model (parent chain) for the quota hierarchy helpers.
jest.unstable_mockModule('../src/models/organization.js', () => {
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

const { resolveRootOrgId, expandOrgScope } = await import('../src/helpers/org-hierarchy.js');
const { Organization } = await import('../src/models/organization.js') as unknown as {
  Organization: {
    __set(list: Array<{ _id: string; parentOrgId: string | null }>): void;
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
