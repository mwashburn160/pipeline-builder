// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Picker reads drain every page. One capped page used to be treated as the whole
 * roster / plugin list, so members past row 200 (and plugins past 500) could not
 * be picked, with nothing saying the list was cut.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';

const getOrganizationMembers = jest.fn<AnyFn>();
const listPlugins = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOrganizationMembers: (...a: unknown[]) => getOrganizationMembers(...a),
    listPlugins: (...a: unknown[]) => listPlugins(...a),
  },
}));

import { listAllOrgMembers, listAllPlugins, LIST_ALL_PAGE_SIZE } from '@/lib/list-all';

const members = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${from + i}` }));

beforeEach(() => { jest.clearAllMocks(); });

describe('listAllOrgMembers', () => {
  it('follows hasMore by offset until the roster is drained', async () => {
    getOrganizationMembers
      .mockResolvedValueOnce({ success: true, data: { members: members(0, LIST_ALL_PAGE_SIZE), pagination: { hasMore: true } } })
      .mockResolvedValueOnce({ success: true, data: { members: members(LIST_ALL_PAGE_SIZE, 7), pagination: { hasMore: false } } });
    const all = await listAllOrgMembers('org-1', { status: 'active' });
    expect(all).toHaveLength(LIST_ALL_PAGE_SIZE + 7);
    expect(getOrganizationMembers).toHaveBeenNthCalledWith(1, 'org-1', { status: 'active', limit: LIST_ALL_PAGE_SIZE, offset: 0 }, { signal: undefined });
    expect(getOrganizationMembers).toHaveBeenNthCalledWith(2, 'org-1', { status: 'active', limit: LIST_ALL_PAGE_SIZE, offset: LIST_ALL_PAGE_SIZE }, { signal: undefined });
  });

  it('keeps going when the server clamps the page below what was asked', async () => {
    getOrganizationMembers
      .mockResolvedValueOnce({ success: true, data: { members: members(0, 200), pagination: { hasMore: true } } })
      .mockResolvedValueOnce({ success: true, data: { members: members(200, 1), pagination: { hasMore: false } } });
    expect(await listAllOrgMembers('org-1')).toHaveLength(201);
    expect(getOrganizationMembers.mock.calls[1][1]).toMatchObject({ offset: 200 });
  });

  it('throws rather than returning a partial roster', async () => {
    getOrganizationMembers
      .mockResolvedValueOnce({ success: true, data: { members: members(0, 3), pagination: { hasMore: true } } })
      .mockRejectedValueOnce(new Error('503'));
    await expect(listAllOrgMembers('org-1')).rejects.toThrow('503');
  });
});

describe('listAllPlugins', () => {
  it('uses the keyset cursor when the server returns one', async () => {
    listPlugins
      .mockResolvedValueOnce({ success: true, data: { plugins: [{ id: 'p1' }], pagination: { hasMore: true, nextCursor: 'c1' } } })
      .mockResolvedValueOnce({ success: true, data: { plugins: [{ id: 'p2' }], pagination: { hasMore: false } } });
    const all = await listAllPlugins({ isActive: 'true' });
    expect(all.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(listPlugins.mock.calls[1][0]).toEqual({ isActive: 'true', limit: String(LIST_ALL_PAGE_SIZE), cursor: 'c1' });
  });

  it('falls back to the offset when no cursor comes back', async () => {
    listPlugins
      .mockResolvedValueOnce({ success: true, data: { plugins: [{ id: 'p1' }, { id: 'p2' }], pagination: { hasMore: true } } })
      .mockResolvedValueOnce({ success: true, data: { plugins: [{ id: 'p3' }], pagination: { hasMore: false } } });
    expect(await listAllPlugins()).toHaveLength(3);
    expect(listPlugins.mock.calls[1][0]).toEqual({ limit: String(LIST_ALL_PAGE_SIZE), offset: '2' });
  });
});
