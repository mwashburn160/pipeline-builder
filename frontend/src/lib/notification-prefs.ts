// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-app notification preferences, per user and organization.
 *
 * The server (`/user/preferences`) is the source of truth, so a preference
 * follows the user across devices. localStorage holds a per-org copy so the UI
 * applies the last known value on first render instead of flashing the thing
 * the user muted while the server responds.
 *
 * Each preference exists only because something in the UI reads it — a toggle
 * that silences nothing is worse than no toggle. Consumers subscribe through
 * {@link useNotificationPrefs}, so a change applies immediately in this tab and
 * in every other open tab.
 */

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import type { UserPreferences } from '@/types';

export type NotificationPrefs = UserPreferences['notifications'];

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  muteQuotaWarnings: false,
};

const STORAGE_PREFIX = 'pb-notification-prefs:v3';
/** Same-tab change signal (the `storage` event only fires in OTHER tabs). */
const CHANGE_EVENT = 'pb-notification-prefs-change';

const storageKey = (orgId: string) => `${STORAGE_PREFIX}:${orgId}`;

function normalize(raw: Partial<NotificationPrefs> | null | undefined): NotificationPrefs {
  return { muteQuotaWarnings: raw?.muteQuotaWarnings === true };
}

/** The locally cached preferences for `orgId` (defaults when none). */
export function readCachedNotificationPrefs(orgId: string): NotificationPrefs {
  if (typeof window === 'undefined' || !orgId) return DEFAULT_NOTIFICATION_PREFS;
  try {
    const raw = window.localStorage.getItem(storageKey(orgId));
    return raw ? normalize(JSON.parse(raw)) : DEFAULT_NOTIFICATION_PREFS;
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

/** Update the local copy and tell every subscriber in this tab. */
function applyLocally(orgId: string, prefs: NotificationPrefs): void {
  try {
    window.localStorage.setItem(storageKey(orgId), JSON.stringify(prefs));
  } catch {
    // localStorage may be unavailable (Safari private mode, quota exceeded).
  }
  window.dispatchEvent(new CustomEvent<{ orgId: string; prefs: NotificationPrefs }>(CHANGE_EVENT, { detail: { orgId, prefs } }));
}

/** One server read per org per page load, shared by every subscriber. */
const serverLoads = new Map<string, Promise<void>>();

function loadFromServer(orgId: string): Promise<void> {
  let load = serverLoads.get(orgId);
  if (!load) {
    load = api.getPreferences()
      .then((res) => {
        if (res.success && res.data) applyLocally(orgId, normalize(res.data.preferences.notifications));
      })
      .catch(() => { /* offline — keep the cached copy */ });
    serverLoads.set(orgId, load);
  }
  return load;
}

/**
 * Save `prefs` for `orgId`. Applies immediately, then persists to the server;
 * if the server rejects it the previous value is restored and the error is
 * rethrown so the caller can say so.
 */
export async function saveNotificationPrefs(orgId: string, prefs: NotificationPrefs): Promise<void> {
  const previous = readCachedNotificationPrefs(orgId);
  applyLocally(orgId, prefs);
  try {
    const res = await api.updatePreferences({ notifications: prefs });
    if (!res.success) throw new Error(res.message || 'Could not save notification preferences');
  } catch (err) {
    applyLocally(orgId, previous);
    throw err;
  }
}

/** Test-only: forget which orgs were already loaded from the server. */
export function __resetNotificationPrefsForTests(): void {
  serverLoads.clear();
}

/** Current preferences for `orgId`, kept in sync with this tab, other tabs, and the server. */
export function useNotificationPrefs(orgId: string | undefined): NotificationPrefs {
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);

  useEffect(() => {
    if (!orgId) return undefined;
    setPrefs(readCachedNotificationPrefs(orgId));
    const onChange = (e: Event) => {
      const { detail } = e as CustomEvent<{ orgId: string; prefs: NotificationPrefs }>;
      if (detail.orgId === orgId) setPrefs(detail.prefs);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey(orgId)) setPrefs(readCachedNotificationPrefs(orgId));
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    void loadFromServer(orgId);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [orgId]);

  return prefs;
}
