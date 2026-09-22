// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Notification preferences.
 *
 * In-app preferences are saved per user and organization on the server (see
 * lib/notification-prefs), so they follow the user across devices, and each one
 * is read by the UI it silences. *Where* alerts are delivered (Slack / webhook /
 * in-app) is org-level configuration and lives on the Alert destinations page,
 * linked below.
 *
 * Plugin-ecosystem EMAIL opt-outs (plan §5b) live in their own card: each one
 * stops only the email for that kind of notice. In-app messages are always
 * delivered, and transactional / security notices (advisories, moderation
 * actions, approvals) ignore these — they can't be turned off.
 */

import Link from 'next/link';
import { Bell, Mail, SlidersHorizontal } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { SectionCard } from '@/components/ui/SectionCard';
import { ToggleRow } from '@/components/ui/SettingRow';
import { ReadOnlyNotice } from '@/components/ui/ReadOnlyNotice';
import { useToast } from '@/components/ui/Toast';
import { formatError } from '@/lib/constants';
import { saveNotificationPrefs, useNotificationPrefs, type NotificationPrefs } from '@/lib/notification-prefs';
import { isSystemOrgActive } from '@/lib/ecosystem-access';

type EcosystemPrefKey = keyof NotificationPrefs['ecosystem'];

/** Ecosystem email opt-outs. `systemOrgOnly` rows exist only for the system
 *  org's moderators (the daily moderation digest). */
const ECOSYSTEM_PREFS: { key: EcosystemPrefKey; label: string; hint: string; systemOrgOnly?: boolean }[] = [
  {
    key: 'reviewsEmail',
    label: 'Review emails',
    hint: 'New or edited reviews on your listings, and publisher replies to a review you wrote.',
  },
  {
    key: 'upgradesEmail',
    label: 'Upgrade and deprecation emails',
    hint: 'New versions and auto-updates of installed plugins (weekly digest), and listings that are deprecated or unmaintained.',
  },
  {
    key: 'installsEmail',
    label: 'Install request emails',
    hint: 'Plugin install requests awaiting your approval, and the decision on installs you requested.',
  },
  {
    key: 'moderationDigestEmail',
    label: 'Daily moderation digest email',
    hint: 'One email a day summarising what is waiting in the ecosystem moderation queue (Ecosystem Managers).',
    systemOrgOnly: true,
  },
];

export default function NotificationsPage() {
  const { isReady, user, isReadOnly } = useAuthGuard();
  const toast = useToast();
  const orgId = user?.organizationId;
  const prefs = useNotificationPrefs(user?.id, orgId);

  const update = async (patch: Partial<NotificationPrefs>) => {
    if (!user?.id || !orgId) return;
    try {
      await saveNotificationPrefs(user.id, orgId, { ...prefs, ...patch });
    } catch (err) {
      // The toggle has already been put back; say why.
      toast.error(formatError(err, 'Could not save your notification preferences'));
    }
  };

  if (!isReady || !user) return <LoadingPage />;

  const inSystemOrg = isSystemOrgActive(user);
  const ecosystemRows = ECOSYSTEM_PREFS.filter((p) => !p.systemOrgOnly || inSystemOrg);

  const orgName = user.organizationName || 'this organization';
  const PREFS = [
    {
      key: 'muteQuotaWarnings' as const,
      label: 'Mute quota warnings',
      hint: 'Hide the banner when usage is nearing a limit. It still appears once a limit is exceeded, because requests are being rejected.',
    },
  ];

  return (
    <DashboardLayout
      title="Notifications"
      subtitle="What you get pinged about — and where"
    >
      <div className="space-y-6">
        <SectionCard
          icon={SlidersHorizontal}
          title="In-app preferences"
          description={`Your preferences for ${orgName}, on every device. They don't change org-level Slack or webhook delivery.`}
          bodyClassName="px-5"
        >
          <ReadOnlyNotice show={isReadOnly} className="mt-4" />
          <div className="divide-y divide-default">
            {PREFS.map(({ key, label, hint }) => (
              <ToggleRow
                key={key}
                label={label}
                description={hint}
                checked={prefs[key]}
                disabled={isReadOnly}
                onChange={(v) => { void update({ [key]: v }); }}
              />
            ))}
          </div>
        </SectionCard>

        <SectionCard
          icon={Mail}
          title="Plugin ecosystem emails"
          description="Email about the plugin ecosystem. Turning one off stops only its email."
          bodyClassName="px-5"
        >
          <ReadOnlyNotice show={isReadOnly} className="mt-4" />
          <div className="divide-y divide-default">
            {ecosystemRows.map(({ key, label, hint }) => (
              <ToggleRow
                key={key}
                label={label}
                description={hint}
                checked={prefs.ecosystem[key]}
                disabled={isReadOnly}
                onChange={(v) => { void update({ ecosystem: { ...prefs.ecosystem, [key]: v } }); }}
              />
            ))}
          </div>
          <p className="py-4 text-xs text-fg-muted">
            In-app messages are always delivered. Security and transactional notices — advisories, moderation
            actions, approvals and rejections — are always emailed and can&apos;t be turned off.
          </p>
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
