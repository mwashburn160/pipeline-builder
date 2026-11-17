// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `userHasSeatInAccount` — whether a person already holds a seat ANYWHERE in the
 * account. Seats count distinct humans across the ROOT's whole subtree, so a
 * member of the root (or of a sibling team) being put on another team takes no
 * new seat. The lookup must therefore walk from the root, not down from the org
 * the person is being added to: walking down from a team never sees the root.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));

/** root → [team-a, team-b]; each team is a leaf. */
const TREE: Record<string, string[]> = { 'root': ['root', 'team-a', 'team-b'], 'team-a': ['team-a'], 'team-b': ['team-b'] };
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  isAncestorOrg: async () => false,
  resolveOrgLineage: async () => ({ rootOrgId: 'root' }),
  expandOrgScope: async (id: string) => TREE[id] ?? [id],
}));

/** Active memberships: the person is a member of the ROOT only. */
const ACTIVE = [{ userId: 'u1', organizationId: 'root' }];
jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: {},
  Invitation: {},
  UserOrganization: {
    exists: (filter: { userId: string; organizationId: { $in: string[] } }) => ({
      session: async () => ACTIVE.find((m) => m.userId === filter.userId && filter.organizationId.$in.includes(m.organizationId)) ?? null,
    }),
  },
}));

const { userHasSeatInAccount } = await import('../src/helpers/seats.js');

describe('userHasSeatInAccount', () => {
  it('sees a seat held in the ROOT when the person is being added to a team', async () => {
    expect(await userHasSeatInAccount('u1', 'team-a')).toBe(true);
  });

  it('is false for someone active nowhere in the account', async () => {
    expect(await userHasSeatInAccount('u2', 'team-a')).toBe(false);
  });
});
