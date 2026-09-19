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

import { Siren } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { FeatureLock } from '@/components/ui/FeatureLock';
import { IncidentReportingSettings } from '@/components/settings/IncidentReportingSettings';

export default function IncidentReportingSettingsPage() {
  const { accessDenied, isReady, user, isReadOnly } = useAuthGuard();
  // Shared entitlement verdict (superadmin bypass included) + the shared lock
  // copy, so this page's "not on your plan" reads like every other one.
  const { entitled, isLoaded } = useFeatureGate('advanced_reporting');

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

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
          <FeatureLock flag="advanced_reporting" />
        ) : (
          <IncidentReportingSettings readOnly={isReadOnly} />
        )}
      </div>
    </DashboardLayout>
  );
}
