// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Organization SSO / Single Sign-On settings (org owner/admin self-service).
 *
 * The org-facing counterpart to the sysadmin IdP roster + per-org modal: an
 * owner/admin configures their OWN org's identity provider here, backed by
 * `GET/PUT/PATCH/DELETE /api/organization/:id/idp`. The page's read gate
 * (`org:idp`, from the nav entry via page-access) is applied by `useAuthGuard`;
 * the `sso` entitlement is a plan question, so an unentitled org sees the
 * standard {@link FeatureLock} upsell in place of the editors. The backend
 * independently enforces both the permission (own-org only) and the entitlement.
 *
 * The page reads the config ONCE and hands it to both protocol editors, the
 * group-mapping editor and the disconnect control, so they all describe the
 * same record and a save (or a disconnect) in one is seen by the rest.
 */

import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { useFetch } from '@/hooks/useFetch';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Callout } from '@/components/ui/Callout';
import { FeatureLock } from '@/components/ui/FeatureLock';
import { ReadOnlyNotice } from '@/components/ui/ReadOnlyNotice';
import { RetryError } from '@/components/ui/RetryError';
import { OrgSsoSettings } from '@/components/settings/OrgSsoSettings';
import { OrgSamlSettings } from '@/components/settings/OrgSamlSettings';
import { SsoDisconnect } from '@/components/settings/SsoDisconnect';
import { SsoGroupMappings } from '@/components/settings/SsoGroupMappings';
import { ScimProvisioning } from '@/components/settings/ScimProvisioning';
import api from '@/lib/api';
import type { OrgIdpConfigDto } from '@/types';

export default function OrgSsoSettingsPage() {
  const { accessDenied, isReady, user, isReadOnly, can } = useAuthGuard();
  // Superadmins hold every entitlement; `useFeatureGate` applies that bypass,
  // mirroring the nav, so the link and this page can't disagree.
  const ssoGate = useFeatureGate('sso');
  const orgId = user?.organizationId;
  const canLoad = isReady && !!orgId && ssoGate.entitled;

  const idp = useFetch(
    async (signal) => (canLoad ? (await api.getOwnOrgIdpConfig(orgId!, { signal })).data?.config ?? null : null),
    [canLoad, orgId],
  );
  // The editors write back what they saved, so the page tracks the current
  // config locally from the last read.
  const [idpConfig, setIdpConfig] = useState<OrgIdpConfigDto | null>(null);
  useEffect(() => { setIdpConfig(idp.data); }, [idp.data]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Single Sign-On"
      subtitle="Configure your organization's identity provider"
      titleExtra={<ShieldCheck className="w-5 h-5 text-blue-600 dark:text-blue-400" />}
    >
      <div className="space-y-6">
        {/* Every control here is a write the backend's read-only guard rejects
            during impersonation — including the SCIM key mint. Without this the
            greyed-out forms read as a broken page. */}
        <ReadOnlyNotice show={isReadOnly} />

        {!ssoGate.isLoaded ? (
          <LoadingPage />
        ) : !ssoGate.entitled ? (
          <FeatureLock flag="sso" />
        ) : !orgId ? (
          <Callout variant="danger">
            Could not determine your active organization. Try reloading the page.
          </Callout>
        ) : idp.error ? (
          <RetryError message={idp.error.message || 'Failed to load the SSO configuration'} onRetry={idp.refetch} />
        ) : idp.loading ? (
          <LoadingPage />
        ) : (
          <>
            <OrgSsoSettings orgId={orgId} config={idpConfig} readOnly={isReadOnly} onSaved={setIdpConfig} />
            {/* SAML 2.0 (#4) — the second protocol, behind the same sign-in path
                and the same `org:idp` + step-up gate as the OIDC connection
                above. It owns the protocol selector, since only one of the two
                can be live for an org at a time. */}
            <OrgSamlSettings orgId={orgId} config={idpConfig} readOnly={isReadOnly} onSaved={setIdpConfig} />
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
            {idpConfig && (
              <SsoDisconnect
                orgId={orgId}
                config={idpConfig}
                readOnly={isReadOnly}
                onDisconnected={() => setIdpConfig(null)}
              />
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
