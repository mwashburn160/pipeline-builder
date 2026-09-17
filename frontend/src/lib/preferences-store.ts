// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one client-side sync layer over `/user/preferences`, scoped per
 * (user, org). Favorites (lib/favorites) and notification preferences
 * (lib/notification-prefs) are thin slices on top of it.
 *
 * - **Server is the source of truth**, so preferences follow the user across
 *   devices. The server resolves the org from the session, so a scope's load
 *   and writes always target the active org.
 * - **localStorage is the synchronous cache**, keyed by user AND org, so two
 *   people sharing a browser never see each other's state. When localStorage is
 *   unavailable (Safari private mode) an in-memory copy stands in.
 * - **One server read per scope per page load**, shared by every consumer.
 * - **A load never clobbers a newer local write.** Each slice carries a
 *   revision, bumped by every local write and persisted with the record (so the
 *   guard holds across tabs too). A load captures the revisions when it starts
 *   and applies a slice only if that slice's revision is unchanged when the
 *   response arrives.
 * - **Change propagation**: same-tab subscribers are notified directly; other
 *   tabs pick changes up from the `storage` event.
 */

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import type { UserPreferences } from '@/types';

export type NotificationPrefs = UserPreferences['notifications'];

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  muteQuotaWarnings: false,
};

/** The preference slices the UI reads. */
export interface Preferences {
  favorites: string[];
  notifications: NotificationPrefs;
}

export type PreferenceSlice = keyof Preferences;

interface StoredRecord {
  prefs: Preferences;
  /** Per-slice local-write revision (the load guard). */
  rev: Record<PreferenceSlice, number>;
}

export const DEFAULT_PREFERENCES: Preferences = {
  favorites: [],
  notifications: DEFAULT_NOTIFICATION_PREFS,
};

const STORAGE_PREFIX = 'pb-user-prefs:v1';

/** The storage key for a (user, org) scope, or null when either is unknown. */
export function preferencesStorageKey(userId: string | undefined, orgId: string | undefined): string | null {
  return userId && orgId ? `${STORAGE_PREFIX}:${userId}:${orgId}` : null;
}

// ── Storage ────────────────────────────────────────────────

/** Fallback when localStorage is unavailable. */
const memory = new Map<string, StoredRecord>();

function normalizeNotifications(raw: Partial<NotificationPrefs> | null | undefined): NotificationPrefs {
  return { muteQuotaWarnings: raw?.muteQuotaWarnings === true };
}

function normalizeFavorites(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

function emptyRecord(): StoredRecord {
  return { prefs: DEFAULT_PREFERENCES, rev: { favorites: 0, notifications: 0 } };
}

function parseRecord(raw: string | null): StoredRecord {
  if (!raw) return emptyRecord();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRecord> | null;
    return {
      prefs: {
        favorites: normalizeFavorites(parsed?.prefs?.favorites),
        notifications: normalizeNotifications(parsed?.prefs?.notifications),
      },
      rev: {
        favorites: Number(parsed?.rev?.favorites) || 0,
        notifications: Number(parsed?.rev?.notifications) || 0,
      },
    };
  } catch {
    return emptyRecord();
  }
}

function readRecord(key: string): StoredRecord {
  if (typeof window === 'undefined') return emptyRecord();
  try {
    const raw = window.localStorage.getItem(key);
    // A write localStorage refused (quota) lives only in memory.
    return raw === null && memory.has(key) ? memory.get(key)! : parseRecord(raw);
  } catch {
    return memory.get(key) ?? emptyRecord();
  }
}

function writeRecord(key: string, record: StoredRecord): void {
  memory.set(key, record);
  try {
    window.localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // localStorage may be unavailable (Safari private mode, quota exceeded) —
    // the in-memory copy keeps this tab correct.
  }
  listeners.forEach((listener) => listener(key));
}

/** A local write: set the slice and bump its revision. Returns the new revision. */
function writeLocal<S extends PreferenceSlice>(key: string, slice: S, value: Preferences[S]): number {
  const record = readRecord(key);
  const rev = record.rev[slice] + 1;
  writeRecord(key, { prefs: { ...record.prefs, [slice]: value }, rev: { ...record.rev, [slice]: rev } });
  return rev;
}

// ── Subscriptions ──────────────────────────────────────────

const listeners = new Set<(key: string) => void>();

// ── Server load ────────────────────────────────────────────

/** One server read per scope per page load, shared by every subscriber. */
const loads = new Map<string, Promise<void>>();

/**
 * Load the scope's preferences from the server (once per page load) and merge
 * them into the cache, slice by slice, skipping any slice written locally since
 * the load started.
 */
export function loadPreferences(userId: string | undefined, orgId: string | undefined): Promise<void> {
  const key = preferencesStorageKey(userId, orgId);
  if (!key || typeof window === 'undefined') return Promise.resolve();
  let load = loads.get(key);
  if (!load) {
    const startRev = readRecord(key).rev;
    load = api.getPreferences()
      .then((res) => {
        if (!res.success || !res.data) return;
        const server = res.data.preferences;
        const current = readRecord(key);
        let prefs = current.prefs;

        if (current.rev.favorites === startRev.favorites) {
          const serverFavorites = normalizeFavorites(server.favorites);
          // Don't wipe a populated local cache with an empty server set
          // (preferences never persisted, or a prior best-effort write-through
          // failed) — seed the server from local instead so the two converge
          // without data loss.
          if (serverFavorites.length === 0 && prefs.favorites.length > 0) {
            void api.updatePreferences({ favorites: [...prefs.favorites] }).catch(() => { /* offline */ });
          } else {
            prefs = { ...prefs, favorites: serverFavorites };
          }
        }
        if (current.rev.notifications === startRev.notifications) {
          prefs = { ...prefs, notifications: normalizeNotifications(server.notifications) };
        }
        // Server values are not local writes: revisions stay as they are.
        if (prefs !== current.prefs) writeRecord(key, { prefs, rev: current.rev });
      })
      .catch(() => { /* offline / preferences endpoint unavailable — keep the cache */ });
    loads.set(key, load);
  }
  return load;
}

// ── Reads & writes ─────────────────────────────────────────

/** The cached preferences for a scope (defaults when unknown). */
export function readPreferences(userId: string | undefined, orgId: string | undefined): Preferences {
  const key = preferencesStorageKey(userId, orgId);
  return key ? readRecord(key).prefs : DEFAULT_PREFERENCES;
}

/**
 * Apply a slice locally right away (bumping its revision, so an in-flight load
 * can't revert it). Returns a handle for rolling back a write the server
 * refused, or null when the scope is unknown.
 */
export function setPreference<S extends PreferenceSlice>(
  userId: string | undefined,
  orgId: string | undefined,
  slice: S,
  value: Preferences[S],
): { rollback: () => void } | null {
  const key = preferencesStorageKey(userId, orgId);
  if (!key || typeof window === 'undefined') return null;
  const previous = readRecord(key).prefs[slice];
  const rev = writeLocal(key, slice, value);
  return {
    // Only undo our own write — a newer local write wins over the rollback.
    rollback: () => { if (readRecord(key).rev[slice] === rev) writeLocal(key, slice, previous); },
  };
}

/** Test-only: forget cached loads and in-memory copies. */
export function __resetPreferencesStoreForTests(): void {
  loads.clear();
  memory.clear();
}

// ── Hook ───────────────────────────────────────────────────

/**
 * The scope's preferences, kept in sync with this tab, other tabs, and the
 * server. Pass the signed-in user's id and active org id; either missing ⇒
 * defaults.
 */
export function usePreferences(userId: string | undefined, orgId: string | undefined): Preferences {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    const key = preferencesStorageKey(userId, orgId);
    if (!key) {
      setPrefs(DEFAULT_PREFERENCES);
      return undefined;
    }
    const refresh = () => setPrefs(readRecord(key).prefs);
    refresh();
    const onChange = (changed: string) => { if (changed === key) refresh(); };
    const onStorage = (e: StorageEvent) => { if (e.key === key) refresh(); };
    listeners.add(onChange);
    window.addEventListener('storage', onStorage);
    void loadPreferences(userId, orgId);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [userId, orgId]);

  return prefs;
}
