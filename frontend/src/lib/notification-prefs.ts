// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-app notification preferences, per user and organization — a slice of the
 * shared preferences store (lib/preferences-store), which owns caching, the
 * single server load, the load-vs-write revision guard, and cross-tab sync.
 *
 * Each preference exists only because something in the UI reads it — a toggle
 * that silences nothing is worse than no toggle.
 */

import api from '@/lib/api';
import { setPreference, usePreferences, type NotificationPrefs } from '@/lib/preferences-store';

export { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '@/lib/preferences-store';

/**
 * Save `prefs` for the scope. Applies immediately, then persists to the server;
 * if the server rejects it the previous value is restored (unless a newer
 * change has landed since) and the error is rethrown so the caller can say so.
 */
export async function saveNotificationPrefs(
  userId: string | undefined,
  orgId: string | undefined,
  prefs: NotificationPrefs,
): Promise<void> {
  const write = setPreference(userId, orgId, 'notifications', prefs);
  if (!write) return;
  try {
    const res = await api.updatePreferences({ notifications: prefs });
    if (!res.success) throw new Error(res.message || 'Could not save notification preferences');
  } catch (err) {
    write.rollback();
    throw err;
  }
}

/** Current preferences for the scope, kept in sync with this tab, other tabs, and the server. */
export function useNotificationPrefs(userId: string | undefined, orgId: string | undefined): NotificationPrefs {
  return usePreferences(userId, orgId).notifications;
}
