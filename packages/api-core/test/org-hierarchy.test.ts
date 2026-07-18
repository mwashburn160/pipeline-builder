// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import {
  MAX_ORG_DEPTH,
  toOrgIdString,
  resolveOrgLineageWith,
  resolveRootOrgIdWith,
  isAncestorOrgWith,
  expandOrgScopeWith,
  type GetParentOrgId,
  type GetChildOrgIds,
} from '../src/helpers/org-hierarchy.js';

// ---------------------------------------------------------------------------
// Injected data sources. The helpers hold no DB dependency — they take a lookup
// callback — so we back them with plain in-memory maps, mirroring how the real
// services pass a Mongoose-reading callback.
// ---------------------------------------------------------------------------

/** parent edges: childOrgId -> parentOrgId. Missing key === root/unknown org. */
function parentLookup(edges: Record<string, string>): GetParentOrgId {
  return async (orgId: string) => edges[orgId];
}

/** children adjacency: parentOrgId -> [childOrgId, ...]. */
function childrenLookup(adj: Record<string, string[]>): GetChildOrgIds {
  return async (frontier: string[]) => frontier.flatMap((id) => adj[id] ?? []);
}

describe('toOrgIdString', () => {
  it('normalizes real ids to strings and drops empties/nullish', () => {
    expect(toOrgIdString('abc')).toBe('abc');
    expect(toOrgIdString({ toString: () => '507f1f77bcf86cd799439011' })).toBe('507f1f77bcf86cd799439011');
    expect(toOrgIdString(null)).toBeUndefined();
    expect(toOrgIdString(undefined)).toBeUndefined();
    expect(toOrgIdString('')).toBeUndefined();
    expect(toOrgIdString('null')).toBeUndefined();
    expect(toOrgIdString('undefined')).toBeUndefined();
  });
});

describe('resolveOrgLineageWith — ancestor chain', () => {
  it('resolves parent + root up a linear chain (D->C->B->A)', async () => {
    const getParent = parentLookup({ D: 'C', C: 'B', B: 'A' });

    const lineage = await resolveOrgLineageWith('D', getParent);
    expect(lineage).toEqual({ parentOrgId: 'C', rootOrgId: 'A' });

    expect(await resolveRootOrgIdWith('D', getParent)).toBe('A');
    expect(await resolveRootOrgIdWith('B', getParent)).toBe('A');
  });

  it('treats a parentless org as its own root with no parentOrgId', async () => {
    const getParent = parentLookup({ D: 'C', C: 'B', B: 'A' });
    const lineage = await resolveOrgLineageWith('A', getParent);
    expect(lineage).toEqual({ rootOrgId: 'A' });
    expect(lineage.parentOrgId).toBeUndefined();
  });
});

describe('resolveOrgLineageWith — cycle safety', () => {
  it('terminates on a two-node cycle A<->B (no infinite loop)', async () => {
    const getParent = parentLookup({ A: 'B', B: 'A' });

    // Guard against a hang: the assertions only run if traversal returns.
    const lineage = await resolveOrgLineageWith('A', getParent);
    expect(lineage.parentOrgId).toBe('B');
    // B's parent (A) is already seen → B is treated as the root and we stop.
    expect(lineage.rootOrgId).toBe('B');
  });

  it('terminates on a self-loop A->A and does not report A as its own parent', async () => {
    const getParent = parentLookup({ A: 'A' });
    const lineage = await resolveOrgLineageWith('A', getParent);
    expect(lineage.rootOrgId).toBe('A');
    expect(lineage.parentOrgId).toBeUndefined();
  });
});

describe('resolveOrgLineageWith — depth cap', () => {
  it(`truncates ancestry at MAX_ORG_DEPTH (${MAX_ORG_DEPTH}) instead of walking forever`, async () => {
    // Chain A0 -> A1 -> ... -> A25 (each Ai's parent is A(i+1)).
    const edges: Record<string, string> = {};
    for (let i = 0; i < 25; i++) edges[`A${i}`] = `A${i + 1}`;
    const getParent = parentLookup(edges);

    // From A0 the walk advances one hop per iteration for MAX_ORG_DEPTH
    // iterations, landing on A{MAX_ORG_DEPTH} as the (truncated) root.
    const root = await resolveRootOrgIdWith('A0', getParent);
    expect(root).toBe(`A${MAX_ORG_DEPTH}`);
  });
});

describe('isAncestorOrgWith', () => {
  const getParent = parentLookup({ D: 'C', C: 'B', B: 'A' });

  it('is true for any strict ancestor', async () => {
    expect(await isAncestorOrgWith('A', 'D', getParent)).toBe(true);
    expect(await isAncestorOrgWith('B', 'D', getParent)).toBe(true);
    expect(await isAncestorOrgWith('C', 'D', getParent)).toBe(true);
  });

  it('is false for self, descendants, and unrelated orgs', async () => {
    expect(await isAncestorOrgWith('A', 'A', getParent)).toBe(false); // not its own ancestor
    expect(await isAncestorOrgWith('D', 'A', getParent)).toBe(false); // wrong direction
    expect(await isAncestorOrgWith('Z', 'D', getParent)).toBe(false); // unrelated
  });

  it('terminates when the candidate sits in a cycle', async () => {
    const cyclic = parentLookup({ A: 'B', B: 'A' });
    // Z is not on the cycle → traversal must exhaust the cycle and return false
    // rather than hang.
    expect(await isAncestorOrgWith('Z', 'A', cyclic)).toBe(false);
  });
});

describe('expandOrgScopeWith — descendant BFS', () => {
  it('returns [self] when the org has no children', async () => {
    const getChildren = childrenLookup({});
    expect(await expandOrgScopeWith('solo', getChildren)).toEqual(['solo']);
  });

  it('de-dupes a diamond so a shared descendant appears once', async () => {
    // A -> B, A -> C, B -> D, C -> D. D is reachable via two paths.
    const getChildren = childrenLookup({ A: ['B', 'C'], B: ['D'], C: ['D'] });

    const scope = await expandOrgScopeWith('A', getChildren);
    expect(new Set(scope)).toEqual(new Set(['A', 'B', 'C', 'D']));
    expect(scope).toHaveLength(4);
    expect(scope.filter((id) => id === 'D')).toHaveLength(1);
  });

  it('is cycle-safe (A<->B does not loop forever)', async () => {
    const getChildren = childrenLookup({ A: ['B'], B: ['A'] });
    const scope = await expandOrgScopeWith('A', getChildren);
    expect(new Set(scope)).toEqual(new Set(['A', 'B']));
    expect(scope).toHaveLength(2);
  });

  it(`caps descendant expansion at MAX_ORG_DEPTH (${MAX_ORG_DEPTH}) levels`, async () => {
    // Linear downward chain A0 -> A1 -> ... -> A25.
    const adj: Record<string, string[]> = {};
    for (let i = 0; i < 25; i++) adj[`A${i}`] = [`A${i + 1}`];
    const getChildren = childrenLookup(adj);

    const scope = await expandOrgScopeWith('A0', getChildren);
    // Self + one node per BFS level for MAX_ORG_DEPTH levels.
    expect(scope).toContain(`A${MAX_ORG_DEPTH}`);
    expect(scope).not.toContain(`A${MAX_ORG_DEPTH + 1}`);
    expect(scope).toHaveLength(MAX_ORG_DEPTH + 1);
  });
});
