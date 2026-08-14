// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org plugin favorites. localStorage is the synchronous read cache; the
 * server (`/user/preferences`) is the source of truth so favorites follow the
 * user across devices. Reads/writes are localStorage-first for instant UX, with
 * best-effort write-through to the server and a hydrate on load.
 */

import api from '@/lib/api';

const KEY_PREFIX = 'pb-plugin-favorites';

function key(orgId: string): string {
  return `${KEY_PREFIX}:${orgId}`;
}

function read(orgId: string): Set<string> {
  if (typeof window === 'undefined' || !orgId) return new Set();
  try {
    const raw = window.localStorage.getItem(key(orgId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function write(orgId: string, ids: Set<string>): void {
  if (typeof window === 'undefined' || !orgId) return;
  try {
    window.localStorage.setItem(key(orgId), JSON.stringify(Array.from(ids)));
  } catch {
    // localStorage may be unavailable (Safari private mode, quota exceeded)
  }
}

export function loadFavorites(orgId: string): Set<string> {
  return read(orgId);
}

export function toggleFavorite(orgId: string, pluginId: string): boolean {
  const current = read(orgId);
  if (current.has(pluginId)) {
    current.delete(pluginId);
  } else {
    current.add(pluginId);
  }
  write(orgId, current);
  // Best-effort write-through to the server (source of truth). Failures are
  // swallowed — the localStorage cache keeps the UI correct offline.
  void api.updatePreferences({ favorites: Array.from(current) }).catch(() => { /* offline / unsupported */ });
  return current.has(pluginId);
}

/**
 * Load favorites from the server and refresh the localStorage cache. Call on
 * mount so a user's favorites appear on a fresh device. Falls back to the cached
 * localStorage set when the server is unreachable or preferences are unset.
 */
export async function hydrateFavoritesFromServer(orgId: string): Promise<Set<string>> {
  if (!orgId) return read(orgId);
  const local = read(orgId);
  try {
    const res = await api.getPreferences();
    if (res.success && res.data) {
      const server = new Set(res.data.preferences.favorites);
      // Don't wipe a populated local cache with an empty server set (preferences
      // never persisted, or a prior best-effort write-through failed) — seed the
      // server from local instead so the two converge without data loss.
      if (server.size === 0 && local.size > 0) {
        void api.updatePreferences({ favorites: [...local] }).catch(() => { /* offline */ });
        return local;
      }
      write(orgId, server);
      return server;
    }
  } catch {
    // offline / preferences endpoint unavailable — keep the localStorage cache
  }
  return local;
}
