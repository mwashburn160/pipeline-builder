// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin favorites, per user and org — a slice of the shared preferences store
 * (lib/preferences-store), which owns caching, the single server load, the
 * load-vs-toggle revision guard, and cross-tab sync.
 */

import { useCallback, useMemo } from 'react';
import api from '@/lib/api';
import { readPreferences, setPreference, usePreferences } from '@/lib/preferences-store';

/**
 * Flip `pluginId` in the scope's favorites. Applies immediately, then writes
 * through to the server best-effort (a failure keeps the local state — the next
 * load reseeds an empty server from it). Returns whether it is now a favorite.
 */
export function toggleFavorite(userId: string | undefined, orgId: string | undefined, pluginId: string): boolean {
  const next = new Set(readPreferences(userId, orgId).favorites);
  if (next.has(pluginId)) next.delete(pluginId);
  else next.add(pluginId);
  const favorites = Array.from(next);
  if (!setPreference(userId, orgId, 'favorites', favorites)) return false;
  void api.updatePreferences({ favorites }).catch(() => { /* offline / unsupported */ });
  return next.has(pluginId);
}

/** The scope's favorite plugin ids, plus a toggle bound to the scope. */
export function useFavorites(userId: string | undefined, orgId: string | undefined): {
  favorites: Set<string>;
  toggle: (pluginId: string) => void;
} {
  const { favorites: list } = usePreferences(userId, orgId);
  const favorites = useMemo(() => new Set(list), [list]);
  const toggle = useCallback((pluginId: string) => { toggleFavorite(userId, orgId, pluginId); }, [userId, orgId]);
  return { favorites, toggle };
}
