// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The refresh-session store (services/session/session-store.ts) — the queries
 * it sends. The behaviour against a real server (per-kind caps, the
 * compare-and-set, TTL/unique indexes) is proven by
 * refresh-sessions.integration.test.ts; this pins the query shapes.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

const lean = <T>(v: T) => ({ lean: async () => v });
let surplus: Array<{ id: string }> = [];
const findChain: Record<string, jest.Mock<AnyFn>> = {};
findChain.sort = jest.fn<AnyFn>(() => findChain);
findChain.skip = jest.fn<AnyFn>(() => findChain);
findChain.select = jest.fn<AnyFn>(() => lean(surplus));
const M = {
  create: jest.fn<AnyFn>(async () => ({})),
  find: jest.fn<AnyFn>(() => findChain),
  findOne: jest.fn<AnyFn>(() => lean(null)),
  exists: jest.fn<AnyFn>(async () => null),
  findOneAndUpdate: jest.fn<AnyFn>(() => lean(null)),
  deleteOne: jest.fn<AnyFn>(async () => ({})),
  deleteMany: jest.fn<AnyFn>(async () => ({})),
  updateMany: jest.fn<AnyFn>(async () => ({})),
};
jest.unstable_mockModule('../src/models/index.js', () => ({ RefreshSession: M }));

const store = await import('../src/services/session/session-store.js');

beforeEach(() => {
  jest.clearAllMocks();
  surplus = [];
});

describe('insertSlot', () => {
  it('stores the row and trims an interactive kind by creation, newest kept', async () => {
    surplus = [{ id: 'old' }];
    const evicted = await store.insertSlot('u1', { id: 'new', kind: 'interactive' } as any, 10);
    expect(M.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'new', userId: 'u1' }));
    expect(M.find).toHaveBeenCalledWith({ userId: 'u1', kind: 'interactive' });
    expect(findChain.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(findChain.skip).toHaveBeenCalledWith(10);
    expect(M.deleteMany).toHaveBeenCalledWith({ userId: 'u1', id: { $in: ['old'] } });
    expect(evicted).toEqual(['old']);
  });

  it('trims machine slots by last use, and deletes nothing under the cap', async () => {
    await expect(store.insertSlot('u1', { id: 'm', kind: 'machine' } as any, 10)).resolves.toEqual([]);
    expect(findChain.sort).toHaveBeenCalledWith({ lastUsedAt: -1, _id: -1 });
    expect(M.deleteMany).not.toHaveBeenCalled();
  });
});

describe('reads', () => {
  it('findSlot is keyed by (userId, id) and answers undefined for none', async () => {
    await expect(store.findSlot('u1', 's1')).resolves.toBeUndefined();
    expect(M.findOne).toHaveBeenCalledWith({ userId: 'u1', id: 's1' });
  });

  it('slotIsLive requires the current tokenVersion', async () => {
    M.exists.mockResolvedValueOnce({ _id: 'x' });
    await expect(store.slotIsLive('u1', 's1', 3)).resolves.toBe(true);
    expect(M.exists).toHaveBeenCalledWith({ userId: 'u1', id: 's1', tokenVersion: 3 });
    await expect(store.slotIsLive('u1', 's1', 3)).resolves.toBe(false);
  });

  it('listSlots returns only slots at the current tokenVersion', async () => {
    M.find.mockReturnValueOnce(lean([{ id: 'a' }]));
    await expect(store.listSlots('u1', 2)).resolves.toEqual([{ id: 'a' }]);
    expect(M.find).toHaveBeenCalledWith({ userId: 'u1', tokenVersion: 2 });
  });
});

describe('writes', () => {
  it('updateSlotIf is a single compare-and-set on the full match', async () => {
    const match = { id: 's1', tokenVersion: 1, kind: 'interactive' as const, scope: null, hash: 'h' };
    await expect(store.updateSlotIf('u1', match, { hash: 'h2' })).resolves.toBe(false);
    expect(M.findOneAndUpdate).toHaveBeenCalledWith({ userId: 'u1', ...match }, { $set: { hash: 'h2' } }, { projection: { _id: 1 } });
    M.findOneAndUpdate.mockReturnValueOnce(lean({ _id: 'x' }));
    await expect(store.updateSlotIf('u1', match, {})).resolves.toBe(true);
  });

  it('deleteSlot / deleteAllSlots (with and without a transaction) / clearEnrollmentPending', async () => {
    await store.deleteSlot('u1', 's1');
    expect(M.deleteOne).toHaveBeenCalledWith({ userId: 'u1', id: 's1' });
    await store.deleteAllSlots('u1');
    expect(M.deleteMany).toHaveBeenLastCalledWith({ userId: { $in: ['u1'] } }, {});
    const session = {} as any;
    await store.deleteAllSlots(['u1', 'u2'], session);
    expect(M.deleteMany).toHaveBeenLastCalledWith({ userId: { $in: ['u1', 'u2'] } }, { session });
    M.deleteMany.mockClear();
    await store.deleteAllSlots([]);
    expect(M.deleteMany).not.toHaveBeenCalled();
    await store.clearEnrollmentPending('u1');
    expect(M.updateMany).toHaveBeenCalledWith({ userId: 'u1', mfaEnrollmentPending: true }, { $unset: { mfaEnrollmentPending: '' } });
  });
});
