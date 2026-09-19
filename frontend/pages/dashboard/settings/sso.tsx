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

import { useState } from 'react';
import { ShieldCheck, Lock } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatures } from '@/hooks/useFeatures';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Callout } from '@/components/ui/Callout';
import { OrgSsoSettings } from '@/components/settings/OrgSsoSettings';
import { OrgSamlSettings } from '@/components/settings/OrgSamlSettings';
import { SsoGroupMappings } from '@/components/settings/SsoGroupMappings';
import { ScimProvisioning } from '@/components/settings/ScimProvisioning';
import type { OrgIdpConfigDto } from '@/types';

export default function OrgSsoSettingsPage() {
  const { isReady, user, isSuperAdmin, isReadOnly, can } = useAuthGuard({ requirePermission: 'org:idp' });
  const { isEnabled, isLoaded } = useFeatures();
  // The mapping editor renders what the CONFIGURED provider supports, and only
  // the connection form below knows which one that is.
  const [idpConfig, setIdpConfig] = useState<OrgIdpConfigDto | null>(null);

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
          <>
            <OrgSsoSettings orgId={orgId} readOnly={isReadOnly} onConfigChange={setIdpConfig} />
            {/* SAML 2.0 (#4) — the second protocol, behind the same sign-in path
                and the same `org:idp` + step-up gate as the OIDC connection
                above. It owns the protocol selector, since only one of the two
                can be live for an org at a time. */}
            <OrgSamlSettings
              orgId={orgId}
              config={idpConfig}
              readOnly={isReadOnly}
              onConfigChange={setIdpConfig}
            />
            {/* Group → role mapping is governed by `roles:manage`, not `org:idp`:
                it grants roles, so an org can delegate the login connection and
                the role policy to different people. The API enforces the same. */}
            {can('roles:manage') && (
              <SsoGroupMappings
                orgId={orgId}
                provider={idpConfig?.provider ?? null}
                protocol={idpConfig?.protocol ?? 'oidc'}
                readOnly={isReadOnly}
              />
            )}
            {/* SCIM rides the same `sso` entitlement as the two above, but its
                control is a MACHINE CREDENTIAL, so it is gated on the capability
                that governs those (`service_accounts:manage`) rather than on
                `org:idp`. The API enforces the same split. */}
            {can('service_accounts:manage') && (
              <ScimProvisioning orgId={orgId} readOnly={isReadOnly} />
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
