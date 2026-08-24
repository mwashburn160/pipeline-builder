// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Organization "Incident reporting" settings (org owner/admin self-service).
 *
 * Sets up + configures the PagerDuty / Datadog / Alertmanager → DORA incident
 * webhook: endpoint URLs (incl. the native Alertmanager adapter), the self-serve
 * `reporting:ingest` webhook token, provider presets, the per-org correlation
 * window, a wiring test, and the recent-incidents list. Gated on org-admin AND
 * the `advanced_reporting` feature entitlement (DORA is the only consumer of
 * incident data). The backend independently re-enforces both.
 */

import { Siren, Lock } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatures } from '@/hooks/useFeatures';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Callout } from '@/components/ui/Callout';
import { IncidentReportingSettings } from '@/components/settings/IncidentReportingSettings';

export default function IncidentReportingSettingsPage() {
  const { isReady, user, isSuperAdmin } = useAuthGuard({ requireAdmin: true });
  const { isEnabled, isLoaded } = useFeatures();

  if (!isReady || !user) return <LoadingPage />;

  // Superadmins hold every feature entitlement (mirroring `isNavItemVisible`), so
  // the nav link and this page agree instead of a superadmin whose own org lacks
  // `advanced_reporting` seeing the link then hitting the upsell wall.
  const entitled = isEnabled('advanced_reporting') || isSuperAdmin;

  return (
    <DashboardLayout
      title="Incident Reporting"
      subtitle="Automated post-deploy CFR + real MTTR from your incident tooling"
      titleExtra={<Siren className="w-5 h-5 text-blue-600 dark:text-blue-400" />}
    >
      <div className="space-y-6">
        {!isLoaded ? (
          <LoadingPage />
        ) : !entitled ? (
          <Callout variant="warning" icon={Lock} title="Incident reporting requires Advanced Reporting.">
            DORA (the consumer of incident data) is included on the Enterprise tier, or available as the Advanced
            Reporting add-on on other tiers. Upgrade or add the entitlement to configure the incident webhook.
          </Callout>
        ) : (
          <IncidentReportingSettings />
        )}
      </div>
    </DashboardLayout>
  );
}
