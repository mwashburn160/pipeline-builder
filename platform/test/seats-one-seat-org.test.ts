// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A 1-seat account — the Developer and Pro tiers — through the real seat
 * helpers (helpers/seats.ts), over a model stub that applies Mongo's semantics.
 *
 * The owner already holds the one seat, so the first invite is refused, and a
 * live pending invite reserves the seat just like a member does. The account's
 * tier rides along with the usage so every "out of seats" message can name the
 * remedy that tier actually has: an upgrade, not a seat pack (seatRemedy).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  isAncestorOrg: async () => false,
  resolveOrgLineage: async () => ({ rootOrgId: 'root' }),
  expandOrgScope: async () => ['root'],
}));

/** A query that resolves to `value` when awaited AND via `.session()` (seats.ts uses both). */
const queryResolving = <T>(value: T) => {
  const p = Promise.resolve(value);
  return Object.assign(p, { session: () => p }) as unknown;
};

let account: { seats: number; tier: string };
let members: string[];
let pending: Array<{ email: string; expiresAt: Date }>;

jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: {
    findById: () => {
      const leaf = { lean: () => Promise.resolve({ quotas: { seats: account.seats }, tier: account.tier }) };
      return { select: () => ({ session: () => leaf, lean: leaf.lean }) };
    },
  },
  UserOrganization: {
    distinct: () => queryResolving(members),
    exists: () => ({ session: () => Promise.resolve(null) }),
  },
  Invitation: {
    // Only genuinely-live invites reserve a seat — honour the expiresAt guard.
    distinct: (_f: string, filter: { expiresAt?: { $gt?: Date } }) =>
      queryResolving(pending.filter((i) => !filter.expiresAt?.$gt || i.expiresAt > filter.expiresAt.$gt).map((i) => i.email)),
  },
}));

const { seatCapacityAvailable, pooledSeatUsage } = await import('../src/helpers/seats.js');
const { seatRemedy } = await import('@pipeline-builder/api-core');

const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);

beforeEach(() => {
  account = { seats: 1, tier: 'developer' };
  members = ['owner'];
  pending = [];
});

describe('a 1-seat account (Developer / Pro)', () => {
  it('refuses the first invite: the owner already holds the only seat', async () => {
    expect(await seatCapacityAvailable('root', 1)).toBe(false);
  });

  it('reports itself full, with the tier that decides the remedy — an upgrade', async () => {
    const usage = await pooledSeatUsage('root');
    expect(usage).toEqual({ limit: 1, used: 1, tier: 'developer' });
    expect(seatRemedy(usage.tier)).toBe('upgrade');
  });

  it('a Pro account is single-seat too, and must upgrade as well', async () => {
    account = { seats: 1, tier: 'pro' };
    expect(await seatCapacityAvailable('root', 1)).toBe(false);
    expect(seatRemedy((await pooledSeatUsage('root')).tier)).toBe('upgrade');
  });

  it('a live pending invite holds the seat exactly as a member does', async () => {
    members = [];
    pending = [{ email: 'a@x.io', expiresAt: future() }];
    expect(await seatCapacityAvailable('root', 1)).toBe(false);
    expect((await pooledSeatUsage('root')).used).toBe(1);
  });

  it('an EXPIRED pending invite frees the seat again', async () => {
    members = [];
    pending = [{ email: 'a@x.io', expiresAt: past() }];
    expect(await seatCapacityAvailable('root', 1)).toBe(true);
  });

  it('has room only while it is empty', async () => {
    members = [];
    expect(await seatCapacityAvailable('root', 1)).toBe(true);
    expect(await seatCapacityAvailable('root', 2)).toBe(false);
  });

  it('once raised past one seat (Team), it has room — and can buy more', async () => {
    account = { seats: 3, tier: 'team' };
    expect(await seatCapacityAvailable('root', 1)).toBe(true);
    expect(seatRemedy((await pooledSeatUsage('root')).tier)).toBe('seat_pack');
  });
});
