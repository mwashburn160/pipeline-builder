// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-user notification preferences + org alert-channel visibility.
 *
 * Two sections:
 *  1. **In-app preferences** — purely client-side (localStorage) toggles
 *     for mute states the UI honors at render time. These are
 *     intentionally local because the platform hasn't shipped a per-
 *     user pref schema; the UI can react to "mute quota warnings"
 *     without a backend round trip.
 *  2. **Org alert channels** — read-only view of the org's configured
 *     destinations (Slack/webhook/in-app). Members see where their
 *     org sends alerts; admins get a "Manage" CTA into the
 *     /dashboard/observability/alert-destinations editor.
 *
 * Future: a backend `/api/user/notification-preferences` would let the
 * mute toggles persist + propagate to push notifications. For now,
 * client-side state is enough to make the UX measurably less noisy.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, Slack, Webhook, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { AlertDestination } from '@/types/observability';

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
  localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
}

function channelIcon(channel: 'slack' | 'webhook' | 'in-app') {
  if (channel === 'slack') return <Slack className="h-4 w-4 text-purple-500" />;
  if (channel === 'webhook') return <Webhook className="h-4 w-4 text-blue-500" />;
  return <Bell className="h-4 w-4 text-gray-500" />;
}

export default function NotificationsPage() {
  const { isReady, user, isAdmin } = useAuthGuard();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [destinations, setDestinations] = useState<AlertDestination[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load prefs from localStorage on mount.
  useEffect(() => { setPrefs(loadPrefs()); }, []);

  // Load the org's alert destinations (read-only, but informative).
  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    setLoading(true);
    api.listAlertDestinations()
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) setDestinations(res.data.destinations);
        else setError(res.message || 'Failed to load alert destinations');
      })
      .catch((e) => !cancelled && setError(formatError(e, 'Failed to load alert destinations')))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [isReady]);

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
      {error && (
        <div className="alert-error mb-4">
          <p>{error}</p>
        </div>
      )}

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

      {/* Org channels — read-only here. Admins jump to the editor via the
          CTA at the bottom; members see what's wired up so they know
          where alerts go and can ask an admin if their channel is missing. */}
      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Your org&apos;s alert channels</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Where {user.organizationName || 'your organization'} delivers production alerts.
            </p>
          </div>
          {isAdmin && (
            <Link href="/dashboard/observability/alert-destinations" className="action-link text-sm">
              Manage →
            </Link>
          )}
        </div>

        {loading && <LoadingSpinner size="sm" />}

        {!loading && destinations.length === 0 && (
          <div className="text-center py-6 text-sm text-gray-500 dark:text-gray-400">
            <AlertTriangle className="h-6 w-6 mx-auto mb-2 text-amber-500" />
            No alert channels configured. {isAdmin
              ? <Link href="/dashboard/observability/alert-destinations" className="action-link">Add one →</Link>
              : 'Ask an org admin to set one up.'}
          </div>
        )}

        {!loading && destinations.length > 0 && (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {destinations.map((d) => (
              <li key={d.id} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  {channelIcon(d.channel)}
                  <div className="min-w-0">
                    <div className="text-gray-900 dark:text-gray-100 font-medium truncate">{d.label}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
                      {d.channel === 'in-app' ? 'in-app' : (d.hasTarget ? d.target : 'not configured')}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Badge color={d.minSeverity === 'critical' ? 'red' : 'yellow'}>{d.minSeverity}</Badge>
                  {d.enabled
                    ? <Badge color="green"><CheckCircle2 className="w-3 h-3 inline -mt-px mr-0.5" /> enabled</Badge>
                    : <Badge color="gray">disabled</Badge>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DashboardLayout>
  );
}
