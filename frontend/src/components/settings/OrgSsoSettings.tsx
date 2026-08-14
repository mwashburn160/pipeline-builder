// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { formatError } from '@/lib/constants';
import api, { ApiError } from '@/lib/api';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { useFormState } from '@/hooks/useFormState';
import type { OrgIdpConfigDto, OrgIdpConfigCreate, IdpProvider } from '@/types';

/**
 * Org owner/admin self-service SSO / IdP editor (the org-facing counterpart to
 * the sysadmin {@link OrgIdpConfigModal}). Reads/writes the caller's OWN org via
 * `GET/PUT /api/organization/:id/idp` — gated on the `org:settings` permission
 * and own-org only, with the `sso` entitlement enforced server-side.
 *
 * `clientSecret` is write-only: the server returns `hasClientSecret` and never
 * echoes the value, so an existing config shows a "secret on file" indicator and
 * the field stays empty unless the admin is rotating it. Only a single PUT
 * (upsert) endpoint is exposed to org admins — omitting `clientSecret` on update
 * keeps the existing secret.
 *
 * Provider-specific config:
 *   - `generic-oidc` → `discoveryUrl` (the .well-known/openid-configuration URL).
 *   - `cognito`      → `region` + `userPoolId` (discovery URL derived server-side).
 *   - `google`/`github` → built-in endpoints; no extra fields.
 */
export function OrgSsoSettings({ orgId }: { orgId: string }) {
  const form = useFormState();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [existing, setExisting] = useState<OrgIdpConfigDto | null>(null);
  const [provider, setProvider] = useState<IdpProvider>('generic-oidc');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [discoveryUrl, setDiscoveryUrl] = useState('');
  const [region, setRegion] = useState('');
  const [userPoolId, setUserPoolId] = useState('');
  const [allowedEmailDomains, setAllowedEmailDomains] = useState('');
  const [enabled, setEnabled] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.getOwnOrgIdpConfig(orgId);
      if (!res.success) {
        setLoadError(res.message || 'Failed to load SSO config');
        return;
      }
      // `config: null` = no IdP configured yet (a normal state) — leave the
      // defaults so the admin gets an empty create form, not an error.
      const c = res.data?.config;
      if (c) {
        setExisting(c);
        setProvider(c.provider);
        setClientId(c.clientId);
        setDiscoveryUrl(c.discoveryUrl || '');
        setRegion(c.region || '');
        setUserPoolId(c.userPoolId || '');
        setAllowedEmailDomains((c.allowedEmailDomains || []).join(', '));
        setEnabled(c.enabled);
      }
    } catch (err) {
      // Legacy safety net: tolerate a 404 (older backends 404'd on no-config).
      if (err instanceof ApiError && err.statusCode === 404) return;
      setLoadError(formatError(err, 'Failed to load SSO config'));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!clientId.trim()) { form.setError('Client ID is required'); return; }
    // On a fresh create the secret is required; on update an empty secret means
    // "leave existing", so only enforce non-empty when there's no existing config.
    if (!existing && !clientSecret.trim()) { form.setError('Client Secret is required for new configs'); return; }
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
    // so only send those; other providers send discoveryUrl and never region/pool.
    const providerFields = provider === 'cognito'
      ? { region: region.trim(), userPoolId: userPoolId.trim() }
      : { discoveryUrl: discoveryUrl || undefined };

    const payload: Partial<OrgIdpConfigCreate> = {
      provider, clientId, ...providerFields,
      allowedEmailDomains: domains, enabled,
    };
    // Only send the secret when it's supplied (write-only; empty = keep existing).
    if (clientSecret.trim()) payload.clientSecret = clientSecret;

    const res = await form.run(
      () => api.putOwnOrgIdpConfig(orgId, payload),
      { successMessage: existing ? 'SSO configuration saved.' : 'SSO configuration created.' },
    );
    if (res !== null) {
      const c = res.data?.config;
      if (c) {
        setExisting(c);
        setClientSecret('');
      }
    }
  };

  return (
    <>
      <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">Single Sign-On (SSO)</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Let members sign in through your identity provider. The client secret is encrypted at rest and never shown after saving.
      </p>

      {loadError ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void load()} className="underline hover:no-underline">Retry</button>
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          <ErrorAlert message={form.error} />
          <SuccessAlert message={form.success} />

          {existing && (
            <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-sm">
              <div className="font-medium text-gray-700 dark:text-gray-300 mb-1">Current config</div>
              <div className="text-gray-600 dark:text-gray-400">
                Provider: <code className="text-xs">{existing.provider}</code> ·
                {' '}Secret: {existing.hasClientSecret ? 'on file' : <em>not set</em>} ·
                {' '}Enabled: {existing.enabled ? 'yes' : 'no'} ·
                {' '}Updated: {new Date(existing.updatedAt).toLocaleString()}
              </div>
            </div>
          )}

          <div>
            <label htmlFor="sso-provider" className="label">Provider</label>
            <Select
              id="sso-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as IdpProvider)}
              disabled={loading || form.loading}
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
              disabled={loading || form.loading}
            />
          </div>

          <div>
            <label htmlFor="sso-client-secret" className="label">
              Client Secret
              {existing && <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">(leave empty to keep existing)</span>}
            </label>
            <Input
              id="sso-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={existing ? '••••••••' : 'Set the OAuth client secret'}
              className="font-mono text-sm"
              disabled={loading || form.loading}
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
                disabled={loading || form.loading}
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
                  disabled={loading || form.loading}
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
                  disabled={loading || form.loading}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  The discovery URL is derived automatically from the region and user pool.
                </p>
              </div>
            </>
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
              disabled={loading || form.loading}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Comma-separated. Empty = any email the IdP authenticates.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={loading || form.loading}
            />
            Enabled
          </label>

          <Button
            type="submit"
            loading={form.loading}
            disabled={loading || !clientId.trim() || (!existing && !clientSecret.trim())}
          >
            {existing ? 'Save SSO settings' : 'Create SSO config'}
          </Button>
        </form>
      )}
    </>
  );
}
