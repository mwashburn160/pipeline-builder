// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin favorites ride the shared per-(user, org) preferences store.
 *
 *   - Toggling applies immediately and writes through to the server.
 *   - State is scoped to the user AND the org: two people sharing a browser
 *     never see each other's favorites.
 *   - A server load that resolves after a toggle does not revert it.
 *   - An empty server is seeded from a populated local cache.
 *   - Favorites and notification prefs share ONE server read per scope.
 *   - Another tab's change shows up via the `storage` event.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook, waitFor } from '@testing-library/react';
import { toggleFavorite, useFavorites } from '../src/lib/favorites';
import { useNotificationPrefs } from '../src/lib/notification-prefs';
import { __resetPreferencesStoreForTests, preferencesStorageKey, readPreferences } from '../src/lib/preferences-store';

const getPreferences = jest.fn<AnyFn>();
const updatePreferences = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getPreferences: (...a: unknown[]) => getPreferences(...a),
    updatePreferences: (...a: unknown[]) => updatePreferences(...a),
  },
}));

const serverPrefs = (favorites: string[], muteQuotaWarnings = false) => ({
  success: true,
  data: { preferences: { favorites, recents: [], notifications: { muteQuotaWarnings } } },
});

/** A getPreferences response the test resolves by hand. */
function deferredLoad() {
  let resolve!: (v: unknown) => void;
  getPreferences.mockReturnValue(new Promise((r) => { resolve = r; }));
  return (v: unknown) => act(async () => { resolve(v); await Promise.resolve(); await Promise.resolve(); });
}

const favs = (userId: string, orgId: string) => new Set(readPreferences(userId, orgId).favorites);

beforeEach(() => {
  window.localStorage.clear();
  __resetPreferencesStoreForTests();
  jest.clearAllMocks();
  getPreferences.mockResolvedValue(serverPrefs([]));
  updatePreferences.mockResolvedValue({ success: true });
});

describe('toggleFavorite', () => {
  it('adds then removes, and writes through to the server', () => {
    expect(toggleFavorite('alice', 'org-a', 'plugin-1')).toBe(true);
    expect(favs('alice', 'org-a').has('plugin-1')).toBe(true);
    expect(updatePreferences).toHaveBeenLastCalledWith({ favorites: ['plugin-1'] });

    expect(toggleFavorite('alice', 'org-a', 'plugin-1')).toBe(false);
    expect(favs('alice', 'org-a').size).toBe(0);
    expect(updatePreferences).toHaveBeenLastCalledWith({ favorites: [] });
  });

  it("is scoped to the user: alice's favorites don't appear for bob in the same org", () => {
    toggleFavorite('alice', 'org-a', 'plugin-1');
    expect(favs('alice', 'org-a').has('plugin-1')).toBe(true);
    expect(favs('bob', 'org-a').size).toBe(0);
  });

  it('is scoped to the org', () => {
    toggleFavorite('alice', 'org-a', 'plugin-1');
    expect(favs('alice', 'org-b').size).toBe(0);
  });

  it('does nothing without a user or org', () => {
    expect(toggleFavorite(undefined, 'org-a', 'plugin-1')).toBe(false);
    expect(toggleFavorite('alice', '', 'plugin-1')).toBe(false);
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it('survives a corrupted cache entry', () => {
    window.localStorage.setItem(preferencesStorageKey('alice', 'org-a')!, '{not json');
    expect(favs('alice', 'org-a').size).toBe(0);
  });
});

describe('useFavorites', () => {
  it('picks favorites up from the server', async () => {
    getPreferences.mockResolvedValue(serverPrefs(['plugin-9']));
    const { result } = renderHook(() => useFavorites('alice', 'org-a'));
    await waitFor(() => expect(result.current.favorites.has('plugin-9')).toBe(true));
  });

  it("does not show alice's favorites to bob (same browser, same org)", async () => {
    toggleFavorite('alice', 'org-a', 'plugin-1');
    const { result } = renderHook(() => useFavorites('bob', 'org-a'));
    await waitFor(() => expect(getPreferences).toHaveBeenCalled());
    expect(result.current.favorites.size).toBe(0);
  });

  it('a server load that resolves AFTER a toggle does not revert it', async () => {
    const resolveLoad = deferredLoad();
    const { result } = renderHook(() => useFavorites('alice', 'org-a'));

    act(() => result.current.toggle('plugin-1'));
    expect(result.current.favorites.has('plugin-1')).toBe(true);

    await resolveLoad(serverPrefs(['stale-server-favorite']));

    expect(result.current.favorites.has('plugin-1')).toBe(true);
    expect(result.current.favorites.has('stale-server-favorite')).toBe(false);
    expect(favs('alice', 'org-a')).toEqual(new Set(['plugin-1']));
  });

  it('seeds an empty server from the local cache instead of wiping it', async () => {
    toggleFavorite('alice', 'org-a', 'plugin-1');
    updatePreferences.mockClear();
    getPreferences.mockResolvedValue(serverPrefs([]));

    const { result } = renderHook(() => useFavorites('alice', 'org-a'));

    await waitFor(() => expect(updatePreferences).toHaveBeenCalledWith({ favorites: ['plugin-1'] }));
    expect(result.current.favorites.has('plugin-1')).toBe(true);
  });

  it('shares one server read per (user, org) with notification prefs', async () => {
    renderHook(() => {
      useFavorites('alice', 'org-a');
      useNotificationPrefs('alice', 'org-a');
      return useFavorites('alice', 'org-a');
    });
    await waitFor(() => expect(getPreferences).toHaveBeenCalled());
    expect(getPreferences).toHaveBeenCalledTimes(1);
  });

  it("follows another tab's change via the storage event", async () => {
    const { result } = renderHook(() => useFavorites('alice', 'org-a'));
    await waitFor(() => expect(getPreferences).toHaveBeenCalled());

    const key = preferencesStorageKey('alice', 'org-a')!;
    const otherTab = { prefs: { favorites: ['from-other-tab'], notifications: { muteQuotaWarnings: false } }, rev: { favorites: 5, notifications: 0 } };
    act(() => {
      window.localStorage.setItem(key, JSON.stringify(otherTab));
      window.dispatchEvent(new StorageEvent('storage', { key }));
    });

    expect(result.current.favorites.has('from-other-tab')).toBe(true);
  });
});
