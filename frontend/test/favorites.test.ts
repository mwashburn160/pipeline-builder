// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Stub localStorage in node test environment.
const store = new Map<string, string>();
(globalThis as unknown as { window: typeof globalThis }).window = globalThis as never;
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
} as Storage;

import { loadFavorites, isFavorite, toggleFavorite } from '../src/lib/favorites';

beforeEach(() => {
  store.clear();
});

describe('plugin favorites', () => {
  it('starts empty', () => {
    expect(loadFavorites('org-a').size).toBe(0);
    expect(isFavorite('org-a', 'plugin-1')).toBe(false);
  });

  it('toggleFavorite adds then removes', () => {
    expect(toggleFavorite('org-a', 'plugin-1')).toBe(true);
    expect(isFavorite('org-a', 'plugin-1')).toBe(true);
    expect(toggleFavorite('org-a', 'plugin-1')).toBe(false);
    expect(isFavorite('org-a', 'plugin-1')).toBe(false);
  });

  it('persists across calls (read-back from localStorage)', () => {
    toggleFavorite('org-a', 'plugin-1');
    toggleFavorite('org-a', 'plugin-2');
    const favs = loadFavorites('org-a');
    expect(favs.has('plugin-1')).toBe(true);
    expect(favs.has('plugin-2')).toBe(true);
    expect(favs.size).toBe(2);
  });

  it('is org-scoped', () => {
    toggleFavorite('org-a', 'plugin-1');
    expect(isFavorite('org-a', 'plugin-1')).toBe(true);
    expect(isFavorite('org-b', 'plugin-1')).toBe(false);
  });

  it('handles missing orgId without throwing', () => {
    expect(() => toggleFavorite('', 'plugin-1')).not.toThrow();
    expect(loadFavorites('').size).toBe(0);
  });

  it('survives corrupted localStorage value', () => {
    window.localStorage.setItem('pb-plugin-favorites:org-a', '{not json');
    expect(loadFavorites('org-a').size).toBe(0);
  });

  it('survives non-array JSON value', () => {
    window.localStorage.setItem('pb-plugin-favorites:org-a', '{"a":1}');
    expect(loadFavorites('org-a').size).toBe(0);
  });
});
