// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { SideDrawer } from '@/components/ui/SideDrawer';
import { FormSection } from '@/components/ui/FormSection';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { FeatureLock } from '@/components/ui/FeatureLock';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { ReadOnlyNotice } from '@/components/ui/ReadOnlyNotice';
import { MfaPolicySettings } from '@/components/settings/MfaPolicySettings';
import { ImpersonationPolicySettings } from '@/components/settings/ImpersonationPolicySettings';
import { OrgSsoSettings } from '@/components/settings/OrgSsoSettings';
import { OrgSamlSettings } from '@/components/settings/OrgSamlSettings';
import { SsoDisconnect } from '@/components/settings/SsoDisconnect';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { useFetch } from '@/hooks/useFetch';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import { formatError } from '@/lib/constants';
import type { OrgTeamRef } from '@/lib/api/domains/organizations';
import type { OrgIdpConfigDto } from '@/types';

/**
 * Settings for ONE team, edited from its parent without switching into it.
 *
 * Every section is the same component the org's own settings page uses, handed
 * the TEAM's org id — so the step-up flows, the read/write shapes and the copy
 * are shared, not forked. Each section keeps its own permission gate (the
 * backend's `canAdministerOrg` then admits a parent admin on the team).
 */
export function TeamSettingsDrawer({
  team,
  onClose,
  onRenamed,
}: {
  team: OrgTeamRef;
  onClose: () => void;
  /** After a rename — the caller refreshes its team list and the switcher. */
  onRenamed: () => void | Promise<void>;
}) {
  const { can, isReadOnly } = useAuthGuard();
  const canSettings = can('org:settings');
  const canImpersonation = can('org:impersonation');
  const canIdp = can('org:idp');

  return (
    <SideDrawer
      title={team.orgName}
      subtitle="Team settings — changes apply to this team only"
      ariaLabel={`Settings for team ${team.orgName}`}
      onClose={onClose}
    >
      <ReadOnlyNotice show={isReadOnly} />
      {canSettings && <TeamIdentitySection team={team} readOnly={isReadOnly} onRenamed={onRenamed} />}
      {canSettings && <MfaPolicySettings orgId={team.orgId} readOnly={isReadOnly} />}
      {canImpersonation && <ImpersonationPolicySettings orgId={team.orgId} readOnly={isReadOnly} />}
      {canIdp && <TeamSsoSection orgId={team.orgId} readOnly={isReadOnly} />}
      {!canSettings && !canImpersonation && !canIdp && (
        <p className="text-sm text-fg-muted">You don&apos;t have permission to change this team&apos;s settings.</p>
      )}
    </SideDrawer>
  );
}

/** Rename the team (`PATCH /organization/:teamId/identity`). */
function TeamIdentitySection({ team, readOnly, onRenamed }: {
  team: OrgTeamRef;
  readOnly: boolean;
  onRenamed: () => void | Promise<void>;
}) {
  const form = useFormState();
  const [name, setName] = useState(team.orgName);
  const [saved, setSaved] = useState(team.orgName);
  useEffect(() => { setName(team.orgName); setSaved(team.orgName); }, [team.orgId, team.orgName]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = name.trim();
    if (next === saved) { form.setError('No changes to save'); return; }
    if (next.length < 2) { form.setError('Team name must be at least 2 characters'); return; }
    const result = await form.run(
      () => api.updateOrganizationIdentity(team.orgId, { name: next }),
      { successMessage: 'Team renamed' },
    );
    if (result !== null) {
      const renamed = result.data?.organization?.name ?? next;
      setName(renamed);
      setSaved(renamed);
      // The team's name is what the org switcher and every org list show, and
      // both read through the shared cache.
      invalidate.organizations();
      await onRenamed();
    }
  };

  return (
    <FormSection
      icon={Building2}
      title="Team name"
      description="How this team appears in the organization switcher and across the dashboard."
      error={form.error}
      success={form.success}
      onSubmit={submit}
      submitLabel="Rename team"
      submitLoading={form.loading}
      submitDisabled={readOnly}
    >
      <FormField label="Name" id={`team-name-${team.orgId}`}>
        <Input
          id={`team-name-${team.orgId}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={readOnly || form.loading}
          maxLength={100}
        />
      </FormField>
    </FormSection>
  );
}

/** The team's own SSO connection (OIDC or SAML), behind the account's `sso` entitlement. */
function TeamSsoSection({ orgId, readOnly }: { orgId: string; readOnly: boolean }) {
  // Entitlements pool at the root, so the parent's verdict is the team's.
  const gate = useFeatureGate('sso');
  const idp = useFetch(
    async (signal) => (gate.entitled ? (await api.getOwnOrgIdpConfig(orgId, { signal })).data?.config ?? null : null),
    [gate.entitled, orgId],
  );
  const [config, setConfig] = useState<OrgIdpConfigDto | null>(null);
  useEffect(() => { setConfig(idp.data); }, [idp.data]);

  if (!gate.isLoaded) return null;
  if (!gate.entitled) return <FeatureLock flag="sso" />;
  if (idp.error) return <RetryError message={formatError(idp.error, 'Failed to load the team\'s SSO configuration')} onRetry={idp.refetch} />;
  if (idp.loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-fg-muted">
        <LoadingSpinner size="sm" /> Loading SSO…
      </div>
    );
  }
  return (
    <>
      <OrgSsoSettings orgId={orgId} config={config} readOnly={readOnly} onSaved={setConfig} />
      <OrgSamlSettings orgId={orgId} config={config} readOnly={readOnly} onSaved={setConfig} />
      {config && <SsoDisconnect orgId={orgId} config={config} readOnly={readOnly} onDisconnected={() => setConfig(null)} />}
    </>
  );
}
