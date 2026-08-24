// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Organization SSO / Single Sign-On settings (org owner/admin self-service).
 *
 * The org-facing counterpart to the sysadmin IdP roster + per-org modal: an
 * owner/admin configures their OWN org's identity provider here, backed by
 * `GET/PUT /api/organization/:id/idp`. Guarded by the `org:idp` permission
 * (the dedicated SSO/IdP capability split out of `org:settings`; superadmins
 * bypass) and additionally gated on the `sso` feature entitlement —
 * unentitled orgs see an upsell notice instead of the form. The backend
 * independently enforces both the permission (own-org only) and the entitlement.
 */

import { ShieldCheck, Lock } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatures } from '@/hooks/useFeatures';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Callout } from '@/components/ui/Callout';
import { OrgSsoSettings } from '@/components/settings/OrgSsoSettings';

export default function OrgSsoSettingsPage() {
  const { isReady, user, isSuperAdmin } = useAuthGuard({ requirePermission: 'org:idp' });
  const { isEnabled, isLoaded } = useFeatures();

  if (!isReady || !user) return <LoadingPage />;

  // Superadmins hold every feature entitlement (mirroring `isNavItemVisible`,
  // which bypasses `requiredFeature` for them) — so the nav link and this page
  // agree instead of a superadmin whose own org lacks `sso` seeing the link
  // then hitting the upsell wall.
  const ssoEntitled = isEnabled('sso') || isSuperAdmin;
  const orgId = user.organizationId;

  return (
    <DashboardLayout
      title="Single Sign-On"
      subtitle="Configure your organization's identity provider"
      titleExtra={<ShieldCheck className="w-5 h-5 text-blue-600 dark:text-blue-400" />}
    >
      <div className="space-y-6">
        {!isLoaded ? (
          <LoadingPage />
        ) : !ssoEntitled ? (
          <Callout variant="warning" icon={Lock} title="SSO is not included in your current plan.">
            Single Sign-On is available on the Team and Enterprise tiers. Upgrade your plan or add the SSO
            entitlement to configure an identity provider for your organization.
          </Callout>
        ) : !orgId ? (
          <Callout variant="danger">
            Could not determine your active organization. Try reloading the page.
          </Callout>
        ) : (
          <OrgSsoSettings orgId={orgId} />
        )}
      </div>
    </DashboardLayout>
  );
}
