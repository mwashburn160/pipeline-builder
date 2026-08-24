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
import { Bell, SlidersHorizontal } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { SectionCard } from '@/components/ui/SectionCard';
import { ToggleRow } from '@/components/ui/SettingRow';
import { Badge } from '@/components/ui/Badge';

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

  const PREFS = [
    { key: 'muteQuotaWarnings' as const, label: 'Mute quota-warning banners', hint: 'Pause "X% of quota used" toasts.' },
    { key: 'muteBuildFailures' as const, label: 'Mute build-failure toasts', hint: 'Failed builds still appear in the executions list and inbox.' },
    { key: 'muteAuditMentions' as const, label: 'Mute audit-mention notifications', hint: 'Hide red dots on audit-event mentions.' },
  ];

  return (
    <DashboardLayout
      title="Notifications"
      subtitle="What you get pinged about — and where"
    >
      <div className="space-y-6">
        {/* In-app preferences — localStorage only; mute is a UI-level filter (the
            underlying alerts still fire on the platform side). */}
        <SectionCard
          icon={SlidersHorizontal}
          title="In-app preferences"
          description="Saved in this browser only — they don't sync across devices, and they don't stop org-level Slack / webhook delivery."
          actions={<Badge color="gray">This browser only</Badge>}
          bodyClassName="px-5"
        >
          <div className="divide-y divide-[var(--pb-border)]">
            {PREFS.map(({ key, label, hint }) => (
              <ToggleRow
                key={key}
                label={label}
                description={hint}
                checked={prefs[key]}
                onChange={(v) => update({ [key]: v } as Partial<Prefs>)}
              />
            ))}
          </div>
        </SectionCard>

        {/* Where alerts go is org-level config — link out instead of duplicating
            the destinations list (it lives only on the Alert destinations page). */}
        <SectionCard
          icon={Bell}
          title="Alert delivery"
          description={`Where ${user.organizationName || 'your organization'} sends production alerts (Slack, webhooks, in-app).`}
          actions={
            <Link href="/dashboard/observability/alert-destinations" className="action-link text-sm shrink-0">
              Alert destinations →
            </Link>
          }
        />
      </div>
    </DashboardLayout>
  );
}
