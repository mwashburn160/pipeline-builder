// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org plugin favorites, persisted in localStorage.
 * Pure module — all DOM access is guarded for SSR.
 */

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
  window.localStorage.setItem(key(orgId), JSON.stringify(Array.from(ids)));
}

export function loadFavorites(orgId: string): Set<string> {
  return read(orgId);
}

export function isFavorite(orgId: string, pluginId: string): boolean {
  return read(orgId).has(pluginId);
}

export function toggleFavorite(orgId: string, pluginId: string): boolean {
  const current = read(orgId);
  if (current.has(pluginId)) {
    current.delete(pluginId);
  } else {
    current.add(pluginId);
  }
  write(orgId, current);
  return current.has(pluginId);
}
