// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Organization SSO / Single Sign-On settings (org owner/admin self-service).
 *
 * The org-facing counterpart to the sysadmin IdP roster + per-org modal: an
 * owner/admin configures their OWN org's identity provider here, backed by
 * `GET/PUT /api/organization/:id/idp`. Guarded by the `org:settings` permission
 * (superadmins bypass) and additionally gated on the `sso` feature entitlement —
 * unentitled orgs see an upsell notice instead of the form. The backend
 * independently enforces both the permission (own-org only) and the entitlement.
 */

import { motion } from 'framer-motion';
import { ShieldCheck, Lock } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatures } from '@/hooks/useFeatures';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { OrgSsoSettings } from '@/components/settings/OrgSsoSettings';

export default function OrgSsoSettingsPage() {
  const { isReady, user } = useAuthGuard({ requirePermission: 'org:settings' });
  const { isEnabled, isLoaded } = useFeatures();

  if (!isReady || !user) return <LoadingPage />;

  const ssoEntitled = isEnabled('sso');
  const orgId = user.organizationId;

  return (
    <DashboardLayout
      title="Single Sign-On"
      subtitle="Configure your organization's identity provider"
      titleExtra={<ShieldCheck className="w-5 h-5 text-blue-600 dark:text-blue-400" />}
    >
      <div className="page-section">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="card"
        >
          {!isLoaded ? (
            <LoadingPage />
          ) : !ssoEntitled ? (
            <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
              <Lock className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">SSO is not included in your current plan.</p>
                <p className="mt-1 text-amber-800 dark:text-amber-300">
                  Single Sign-On is available on the Team and Enterprise tiers. Upgrade your plan or add the SSO
                  entitlement to configure an identity provider for your organization.
                </p>
              </div>
            </div>
          ) : !orgId ? (
            <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" role="alert">
              Could not determine your active organization. Try reloading the page.
            </div>
          ) : (
            <OrgSsoSettings orgId={orgId} />
          )}
        </motion.div>
      </div>
    </DashboardLayout>
  );
}
