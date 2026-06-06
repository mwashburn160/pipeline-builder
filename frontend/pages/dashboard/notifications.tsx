// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-user notification preferences (client-side).
 *
 * In-app mute toggles, stored in localStorage — the platform hasn't shipped a
 * per-user pref schema yet, so these react at render time without a backend
 * round trip. *Where* alerts are delivered (Slack / webhook / in-app) is
 * org-level configuration and lives on the single Alert destinations page,
 * linked below — this page no longer duplicates that list.
 *
 * Future: a backend `/api/user/notification-preferences` would let the mute
 * toggles persist + propagate to push notifications.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';

/** localStorage keys for in-app preferences. Bumped if the shape changes. */
const PREF_KEY = 'pb-notification-prefs:v1';

interface Prefs {
  muteQuotaWarnings: boolean;
  muteBuildFailures: boolean;
  muteAuditMentions: boolean;
}

const DEFAULT_PREFS: Prefs = {
  muteQuotaWarnings: false,
  muteBuildFailures: false,
  muteAuditMentions: false,
};

function loadPrefs(): Prefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: Prefs): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage may be unavailable (Safari private mode, quota exceeded)
  }
}

export default function NotificationsPage() {
  const { isReady, user } = useAuthGuard();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);

  // Load prefs from localStorage on mount.
  useEffect(() => { setPrefs(loadPrefs()); }, []);

  const update = (patch: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePrefs(next);
      return next;
    });
  };

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Notifications"
      subtitle="What you get pinged about — and where"
    >
      {/* In-app preferences. Stored in localStorage; survives reloads but
          doesn't sync across devices. Mute is a UI-level filter — the
          underlying alerts still fire on the platform side. */}
      <div className="card mb-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">In-app preferences</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Mute toggles hide banners in your browser. They don&apos;t stop org-level Slack / webhook delivery.
        </p>
        <ul className="space-y-2 text-sm">
          {[
            { key: 'muteQuotaWarnings' as const, label: 'Mute quota-warning banners', hint: 'Pause "X% of quota used" toasts.' },
            { key: 'muteBuildFailures' as const, label: 'Mute build-failure toasts', hint: 'Failed builds still appear in the executions list and inbox.' },
            { key: 'muteAuditMentions' as const, label: 'Mute audit-mention notifications', hint: 'Hide red dots on audit-event mentions.' },
          ].map(({ key, label, hint }) => (
            <li key={key} className="flex items-start justify-between gap-3 py-1">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{hint}</div>
              </div>
              <label className="inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={prefs[key]}
                  onChange={(e) => update({ [key]: e.target.checked } as Partial<Prefs>)}
                  className="h-4 w-4"
                />
              </label>
            </li>
          ))}
        </ul>
      </div>

      {/* Where alerts go is org-level config — link out instead of duplicating
          the destinations list (it lives only on the Alert destinations page). */}
      <div className="card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Bell className="h-5 w-5 text-gray-400 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Alert delivery</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Where {user.organizationName || 'your organization'} sends production alerts (Slack, webhooks, in-app).
              </p>
            </div>
          </div>
          <Link href="/dashboard/observability/alert-destinations" className="action-link text-sm shrink-0">
            Alert destinations →
          </Link>
        </div>
      </div>
    </DashboardLayout>
  );
}
