// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import api, { ApiError } from '@/lib/api';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import type { Organization, OrgIdpConfigDto } from '@/types';

interface Props {
  org: Organization;
  onClose: () => void;
  onSaved?: () => void;
}

type Provider = 'generic-oidc' | 'cognito' | 'google' | 'github';

/**
 * Sysadmin modal for managing an org's SSO / IdP configuration.
 *
 * Three providers are supported. `clientSecret` is write-only — the server
 * returns `hasClientSecret: boolean` and never echoes the value back, so
 * existing configs show a "secret on file" indicator and the input field
 * stays empty unless the operator is rotating it.
 *
 * For `generic-oidc`, `discoveryUrl` is required (the .well-known/openid-
 * configuration URL); google/github use built-in endpoints and the field
 * is optional. `allowedEmailDomains` is a comma-separated list — empty
 * means "any email domain accepted by the IdP."
 */
export function OrgIdpConfigModal({ org, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<OrgIdpConfigDto | null>(null);
  const [provider, setProvider] = useState<Provider>('generic-oidc');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [discoveryUrl, setDiscoveryUrl] = useState('');
  const [region, setRegion] = useState('');
  const [userPoolId, setUserPoolId] = useState('');
  const [allowedEmailDomains, setAllowedEmailDomains] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getOrgIdpConfig(org.id).then((res) => {
      if (cancelled) return;
      if (!res.success) {
        setError(res.message || 'Failed to load IdP config');
        return;
      }
      // `config: null` = no IdP configured yet (a normal state) — leave the
      // defaults so the operator gets an empty create form, not an error.
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
    }).catch((err) => {
      if (cancelled) return;
      // Legacy safety net: older backends 404'd when no config existed; the
      // endpoint now returns 200 + `config: null`, but tolerate a 404 too.
      if (err instanceof ApiError && err.statusCode === 404) return;
      setError(err instanceof Error ? err.message : String(err));
    })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [org.id]);

  const handleSave = useCallback(async () => {
    setError(null);
    if (!clientId.trim()) { setError('Client ID is required'); return; }
    // `clientSecret` empty during a PATCH means "leave existing", so only
    // require non-empty on a fresh PUT (when there's no existing config).
    if (!existing && !clientSecret.trim()) { setError('Client Secret is required for new configs'); return; }
    if (provider === 'generic-oidc' && !discoveryUrl.trim()) {
      setError('discoveryUrl is required for generic-oidc'); return;
    }
    if (provider === 'cognito' && (!region.trim() || !userPoolId.trim())) {
      setError('Region and User Pool ID are required for cognito'); return;
    }

    const domains = allowedEmailDomains
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);

    // For cognito the server derives the discovery URL from region + userPoolId,
    // so only send those; other providers send discoveryUrl and never region/pool.
    const providerFields = provider === 'cognito'
      ? { region: region.trim(), userPoolId: userPoolId.trim(), discoveryUrl: undefined }
      : { discoveryUrl: discoveryUrl || undefined, region: undefined, userPoolId: undefined };

    setSubmitting(true);
    try {
      if (existing) {
        // PATCH — only send the fields that changed; clientSecret only when supplied.
        const patch: Partial<{ provider: Provider; clientId: string; clientSecret: string; discoveryUrl: string; region: string; userPoolId: string; allowedEmailDomains: string[]; enabled: boolean }> = {
          provider, clientId, ...providerFields,
          allowedEmailDomains: domains, enabled,
        };
        if (clientSecret.trim()) patch.clientSecret = clientSecret;
        const res = await api.patchOrgIdpConfig(org.id, patch);
        if (!res.success) throw new Error(res.message || 'Patch failed');
      } else {
        const res = await api.putOrgIdpConfig(org.id, {
          provider, clientId, clientSecret,
          ...providerFields,
          allowedEmailDomains: domains, enabled,
        });
        if (!res.success) throw new Error(res.message || 'Create failed');
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [org.id, provider, clientId, clientSecret, discoveryUrl, region, userPoolId, allowedEmailDomains, enabled, existing, onSaved, onClose]);

  const handleDelete = useCallback(async () => {
    if (!window.confirm(`Remove IdP config for "${org.name}"? SSO will be disabled for this org.`)) return;
    setSubmitting(true);
    try {
      const res = await api.deleteOrgIdpConfig(org.id);
      if (!res.success) throw new Error(res.message || 'Delete failed');
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [org.id, org.name, onSaved, onClose]);

  return (
    <Modal
      title={`IdP Config — ${org.name}`}
      titleIcon={<ShieldCheck className="w-5 h-5 shrink-0" />}
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          {existing && (
            <Button variant="danger-outline" onClick={handleDelete} disabled={submitting}>
              Remove
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={submitting || !clientId.trim() || (!existing && !clientSecret.trim())}
          >
            {submitting ? <LoadingSpinner size="sm" /> : (existing ? 'Save changes' : 'Create')}
          </Button>
        </div>
      }
    >
        <div className="space-y-4">
          {loading && <LoadingSpinner size="sm" />}

          <ErrorAlert message={error} />

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
            <label className="label">Provider</label>
            <Select
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
              disabled={submitting}
            >
              <option value="generic-oidc">Generic OIDC</option>
              <option value="cognito">AWS Cognito</option>
              <option value="google">Google</option>
              <option value="github">GitHub</option>
            </Select>
          </div>

          <div>
            <label className="label">Client ID</label>
            <Input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="oauth-client-id"
              className="font-mono text-sm"
              disabled={submitting}
            />
          </div>

          <div>
            <label className="label">
              Client Secret
              {existing && <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">(leave empty to keep existing)</span>}
            </label>
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={existing ? '••••••••' : 'Set the OAuth client secret'}
              className="font-mono text-sm"
              disabled={submitting}
              autoComplete="new-password"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Encrypted at rest under the org&apos;s key provider. Never echoed back on read.
            </p>
          </div>

          {provider === 'generic-oidc' && (
            <div>
              <label className="label">Discovery URL</label>
              <Input
                type="url"
                value={discoveryUrl}
                onChange={(e) => setDiscoveryUrl(e.target.value)}
                placeholder="https://idp.example.com/.well-known/openid-configuration"
                className="font-mono text-sm"
                disabled={submitting}
              />
            </div>
          )}

          {provider === 'cognito' && (
            <>
              <div>
                <label className="label">Region</label>
                <Input
                  type="text"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="us-east-1"
                  className="font-mono text-sm"
                  disabled={submitting}
                />
              </div>
              <div>
                <label className="label">User Pool ID</label>
                <Input
                  type="text"
                  value={userPoolId}
                  onChange={(e) => setUserPoolId(e.target.value)}
                  placeholder="us-east-1_aB1cD2eF3"
                  className="font-mono text-sm"
                  disabled={submitting}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  The discovery URL is derived server-side from the region and user pool.
                </p>
              </div>
            </>
          )}

          <div>
            <label className="label">Allowed Email Domains</label>
            <Input
              type="text"
              value={allowedEmailDomains}
              onChange={(e) => setAllowedEmailDomains(e.target.value)}
              placeholder="example.com, acme.io"
              className="text-sm"
              disabled={submitting}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Comma-separated. Empty = any email the IdP authenticates.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={submitting}
            />
            Enabled
          </label>

        </div>
      </Modal>
  );
}
