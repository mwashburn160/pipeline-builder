// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import api from '@/lib/api';
import { SectionCard } from '@/components/ui/SectionCard';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { ReadOnlyNotice } from '@/components/ui/ReadOnlyNotice';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useFormState } from '@/hooks/useFormState';
import type { OrgIdpConfigDto, OrgIdpConfigCreate, IdpProvider } from '@/types';
import { formatDateTime } from '@/lib/format';
import { changedIdpFields } from './idp-diff';

/**
 * Org owner/admin self-service OIDC connection editor (the org-facing
 * counterpart to the sysadmin {@link OrgIdpConfigModal}). The page loads the
 * org's config once and hands it here (and to the SAML editor beside it), so
 * both edit the same record.
 *
 * ONE write per case: a brand-new connection is CREATED with
 * `PUT /organization/:id/idp` (the full body the protocol requires); every
 * later save is a `PATCH` carrying only the fields that changed. Both need an
 * MFA-grade session and a strong-factor step-up, so Save opens ONE
 * `StepUpModal` (passkey / authenticator code) that confirms the write and
 * earns its token. Disconnecting lives in {@link SsoDisconnect}.
 *
 * `clientSecret` is write-only: the server returns `hasClientSecret` and never
 * echoes the value, so an existing config shows a "secret on file" indicator and
 * the field stays empty unless the admin is rotating it.
 *
 * Provider-specific config:
 *   - `generic-oidc` → `discoveryUrl` (the .well-known/openid-configuration URL).
 *   - `cognito`      → `region` + `userPoolId` (discovery URL derived server-side).
 *   - `google`/`github` → built-in endpoints; no extra fields.
 */
export function OrgSsoSettings({
  orgId,
  config,
  readOnly,
  onSaved,
}: {
  orgId: string;
  /** The org's stored config, or null when none exists yet. */
  config: OrgIdpConfigDto | null;
  readOnly: boolean;
  /** Fired with the saved config so the page and its sibling editors see it. */
  onSaved: (config: OrgIdpConfigDto) => void;
}) {
  const form = useFormState();
  const [provider, setProvider] = useState<IdpProvider>('generic-oidc');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [discoveryUrl, setDiscoveryUrl] = useState('');
  const [region, setRegion] = useState('');
  const [userPoolId, setUserPoolId] = useState('');
  const [groupsClaim, setGroupsClaim] = useState('');
  const [allowedEmailDomains, setAllowedEmailDomains] = useState('');
  const [enabled, setEnabled] = useState(true);
  // The validated write, held while the step-up dialog is open.
  const [pendingWrite, setPendingWrite] = useState<((stepUpToken: string) => ReturnType<typeof api.putOwnOrgIdpConfig>) | null>(null);

  // Google (and GitHub, which isn't an OpenID provider at all) issue no group
  // claim, so just-in-time Role mapping cannot work there — the field is hidden
  // and the limitation stated, rather than letting an admin configure a rule set
  // that would silently never fire. The server refuses it independently.
  const supportsGroups = provider !== 'google' && provider !== 'github';
  // A secret is needed until one is on file — a new connection, or a SAML org
  // filling in its OIDC side for the first time.
  const needsSecret = !config?.hasClientSecret;

  // Mirror the stored config whenever the page (re)loads it — including back to
  // the empty create form after a disconnect. A SAML config has no provider;
  // the OIDC fields then stay on their defaults.
  useEffect(() => {
    setProvider(config?.provider ?? 'generic-oidc');
    setClientId(config?.clientId ?? '');
    setClientSecret('');
    setDiscoveryUrl(config?.discoveryUrl ?? '');
    setRegion(config?.region ?? '');
    setUserPoolId(config?.userPoolId ?? '');
    setGroupsClaim(config?.groupsClaim ?? '');
    setAllowedEmailDomains((config?.allowedEmailDomains ?? []).join(', '));
    setEnabled(config?.enabled ?? true);
  }, [config]);

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (readOnly) return;
    if (!clientId.trim()) { form.setError('Client ID is required'); return; }
    if (needsSecret && !clientSecret.trim()) { form.setError('Client Secret is required for a new connection'); return; }
    if (provider === 'generic-oidc' && !discoveryUrl.trim()) {
      form.setError('Discovery URL is required for generic OIDC'); return;
    }
    if (provider === 'cognito' && (!region.trim() || !userPoolId.trim())) {
      form.setError('Region and User Pool ID are required for Cognito'); return;
    }

    const domains = allowedEmailDomains
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);

    // For cognito the server derives the discovery URL from region + userPoolId,
    // so only those are sent; other providers send discoveryUrl and never
    // region/pool.
    const providerFields = provider === 'cognito'
      ? { region: region.trim(), userPoolId: userPoolId.trim() }
      : { discoveryUrl: discoveryUrl.trim() || undefined };

    const desired: Partial<OrgIdpConfigCreate> = {
      provider, clientId: clientId.trim(), ...providerFields,
      // Empty string clears it back to the `groups` default; a provider without
      // group claims always sends the clear, so switching to Google can't leave
      // a stale claim name behind (the server would reject the pair anyway).
      groupsClaim: supportsGroups ? groupsClaim.trim() : '',
      allowedEmailDomains: domains, enabled,
      // Write-only; empty = keep the stored one.
      ...(clientSecret.trim() ? { clientSecret } : {}),
    };

    form.reset();
    if (config) {
      const patch = changedIdpFields(config, desired);
      if (Object.keys(patch).length === 0) { form.setSuccess('No changes to save.'); return; }
      setPendingWrite(() => (token: string) => api.patchOwnOrgIdpConfig(orgId, patch, token));
    } else {
      setPendingWrite(() => (token: string) => api.putOwnOrgIdpConfig(orgId, desired, token));
    }
  };

  const executeWrite = async (stepUpToken: string) => {
    const write = pendingWrite;
    setPendingWrite(null);
    if (!write) return;
    const res = await form.run(() => write(stepUpToken), { successMessage: config ? 'SSO configuration saved.' : 'SSO configuration created.' });
    const saved = res?.data?.config;
    if (saved) {
      setClientSecret('');
      onSaved(saved);
    }
  };

  return (
    <SectionCard
      icon={ShieldCheck}
      title="Single Sign-On (SSO)"
      description="Let members sign in through your identity provider. The client secret is encrypted at rest and never shown after saving."
    >
      <form onSubmit={handleSave} className="space-y-4">
        <ReadOnlyNotice show={readOnly} />
        <ErrorAlert message={form.error} />
        <SuccessAlert message={form.success} />

        {config && (
          <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-sm">
            <div className="font-medium text-gray-700 dark:text-gray-300 mb-1">Current config</div>
            <div className="text-gray-600 dark:text-gray-400">
              Protocol: <code className="text-xs">{config.protocol}</code> ·
              {config.provider && <>{' '}Provider: <code className="text-xs">{config.provider}</code> ·</>}
              {' '}Secret: {config.hasClientSecret ? 'on file' : <em>not set</em>} ·
              {' '}Enabled: {config.enabled ? 'yes' : 'no'} ·
              {' '}Updated: {formatDateTime(config.updatedAt)}
            </div>
          </div>
        )}

        {/* Read-only impersonation: the backend rejects every write, so disable the
            whole form (inputs + submit) rather than dead-ending on a 403. */}
        <fieldset disabled={readOnly} className="space-y-4">
          <div>
            <label htmlFor="sso-provider" className="label">Provider</label>
            <Select
              id="sso-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as IdpProvider)}
              disabled={form.loading}
            >
              <option value="generic-oidc">Generic OIDC</option>
              <option value="cognito">AWS Cognito</option>
              <option value="google">Google</option>
              <option value="github">GitHub</option>
            </Select>
          </div>

          <div>
            <label htmlFor="sso-client-id" className="label">Client ID</label>
            <Input
              id="sso-client-id"
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="oauth-client-id"
              className="font-mono text-sm"
              disabled={form.loading}
            />
          </div>

          <div>
            <label htmlFor="sso-client-secret" className="label">
              Client Secret
              {!needsSecret && <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">(leave empty to keep existing)</span>}
            </label>
            <Input
              id="sso-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={needsSecret ? 'Set the OAuth client secret' : '••••••••'}
              className="font-mono text-sm"
              disabled={form.loading}
              autoComplete="new-password"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Encrypted at rest under your organization&apos;s key provider. Never echoed back on read.
            </p>
          </div>

          {provider === 'generic-oidc' && (
            <div>
              <label htmlFor="sso-discovery-url" className="label">Discovery URL</label>
              <Input
                id="sso-discovery-url"
                type="url"
                value={discoveryUrl}
                onChange={(e) => setDiscoveryUrl(e.target.value)}
                placeholder="https://idp.example.com/.well-known/openid-configuration"
                className="font-mono text-sm"
                disabled={form.loading}
              />
            </div>
          )}

          {provider === 'cognito' && (
            <>
              <div>
                <label htmlFor="sso-region" className="label">Region</label>
                <Input
                  id="sso-region"
                  type="text"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="us-east-1"
                  className="font-mono text-sm"
                  disabled={form.loading}
                />
              </div>
              <div>
                <label htmlFor="sso-user-pool-id" className="label">User Pool ID</label>
                <Input
                  id="sso-user-pool-id"
                  type="text"
                  value={userPoolId}
                  onChange={(e) => setUserPoolId(e.target.value)}
                  placeholder="us-east-1_aB1cD2eF3"
                  className="font-mono text-sm"
                  disabled={form.loading}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  The discovery URL is derived automatically from the region and user pool.
                </p>
              </div>
            </>
          )}

          {supportsGroups ? (
            <div>
              <label htmlFor="sso-groups-claim" className="label">
                Groups Claim
                <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">(optional)</span>
              </label>
              <Input
                id="sso-groups-claim"
                type="text"
                value={groupsClaim}
                onChange={(e) => setGroupsClaim(e.target.value)}
                placeholder={provider === 'cognito' ? 'cognito:groups' : 'groups'}
                className="font-mono text-sm"
                disabled={form.loading}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Name of the token claim carrying group memberships — <code>groups</code> for Okta and
                Keycloak, <code>cognito:groups</code> for Cognito. Leave empty to use <code>groups</code>.
                Map those groups to roles below.
              </p>
            </div>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {provider === 'google'
                ? 'Google sign-in cannot map groups to roles: Google\'s OIDC tokens carry no group claim. Members signing in through Google are added to the organization with the member role only.'
                : 'GitHub is not an OpenID provider, so it supports neither SSO sign-in nor group-to-role mapping.'}
            </p>
          )}

          <div>
            <label htmlFor="sso-domains" className="label">Allowed Email Domains</label>
            <Input
              id="sso-domains"
              type="text"
              value={allowedEmailDomains}
              onChange={(e) => setAllowedEmailDomains(e.target.value)}
              placeholder="example.com, acme.io"
              className="text-sm"
              disabled={form.loading}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Comma-separated. Empty = any email the IdP authenticates.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={form.loading}
            />
            Enabled
          </label>

          <Button
            type="submit"
            loading={form.loading}
            disabled={!clientId.trim() || (needsSecret && !clientSecret.trim())}
          >
            {config ? 'Save SSO settings' : 'Create SSO config'}
          </Button>
        </fieldset>
      </form>

      {pendingWrite && (
        <StepUpModal
          action={config ? 'Change your organization\'s SSO connection' : 'Connect your organization to an identity provider'}
          // The IdP routes accept only a second factor: whoever controls the
          // connection can sign in as any member.
          requireStrongFactor
          onConfirmed={executeWrite}
          onClose={() => setPendingWrite(null)}
        />
      )}
    </SectionCard>
  );
}
