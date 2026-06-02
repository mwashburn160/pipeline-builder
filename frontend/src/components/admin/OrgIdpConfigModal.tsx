// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { X, ShieldCheck } from 'lucide-react';
import api, { ApiError } from '@/lib/api';
import { LoadingSpinner } from '@/components/ui/Loading';
import type { Organization, OrgIdpConfigDto } from '@/types';

interface Props {
  org: Organization;
  onClose: () => void;
  onSaved?: () => void;
}

type Provider = 'generic-oidc' | 'google' | 'github';

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
  const [allowedEmailDomains, setAllowedEmailDomains] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getOrgIdpConfig(org.id).then((res) => {
      if (cancelled) return;
      if (res.success && res.data?.config) {
        const c = res.data.config;
        setExisting(c);
        setProvider(c.provider);
        setClientId(c.clientId);
        setDiscoveryUrl(c.discoveryUrl || '');
        setAllowedEmailDomains((c.allowedEmailDomains || []).join(', '));
        setEnabled(c.enabled);
      } else {
        setError(res.message || 'Failed to load IdP config');
      }
    }).catch((err) => {
      if (cancelled) return;
      // 404 = no config yet; leave defaults so the operator gets an empty
      // create form rather than a scary error banner.
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

    const domains = allowedEmailDomains
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);

    setSubmitting(true);
    try {
      if (existing) {
        // PATCH — only send the fields that changed; clientSecret only when supplied.
        const patch: Partial<{ provider: Provider; clientId: string; clientSecret: string; discoveryUrl: string; allowedEmailDomains: string[]; enabled: boolean }> = {
          provider, clientId, discoveryUrl: discoveryUrl || undefined,
          allowedEmailDomains: domains, enabled,
        };
        if (clientSecret.trim()) patch.clientSecret = clientSecret;
        const res = await api.patchOrgIdpConfig(org.id, patch);
        if (!res.success) throw new Error(res.message || 'Patch failed');
      } else {
        const res = await api.putOrgIdpConfig(org.id, {
          provider, clientId, clientSecret,
          discoveryUrl: discoveryUrl || undefined,
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
  }, [org.id, provider, clientId, clientSecret, discoveryUrl, allowedEmailDomains, enabled, existing, onSaved, onClose]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <ShieldCheck className="w-5 h-5" /> IdP Config — {org.name}
          </h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-800">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {loading && <LoadingSpinner size="sm" />}

          {error && (
            <div className="alert-error">
              <p>{error}</p>
            </div>
          )}

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
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
              className="input"
              disabled={submitting}
            >
              <option value="generic-oidc">Generic OIDC</option>
              <option value="google">Google</option>
              <option value="github">GitHub</option>
            </select>
          </div>

          <div>
            <label className="label">Client ID</label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="oauth-client-id"
              className="input font-mono text-sm"
              disabled={submitting}
            />
          </div>

          <div>
            <label className="label">
              Client Secret
              {existing && <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">(leave empty to keep existing)</span>}
            </label>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={existing ? '••••••••' : 'Set the OAuth client secret'}
              className="input font-mono text-sm"
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
              <input
                type="url"
                value={discoveryUrl}
                onChange={(e) => setDiscoveryUrl(e.target.value)}
                placeholder="https://idp.example.com/.well-known/openid-configuration"
                className="input font-mono text-sm"
                disabled={submitting}
              />
            </div>
          )}

          <div>
            <label className="label">Allowed Email Domains</label>
            <input
              type="text"
              value={allowedEmailDomains}
              onChange={(e) => setAllowedEmailDomains(e.target.value)}
              placeholder="example.com, acme.io"
              className="input text-sm"
              disabled={submitting}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Comma-separated. Empty = any email the IdP authenticates.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={submitting}
            />
            Enabled
          </label>

          <div className="flex items-center justify-end gap-2 pt-2">
            {existing && (
              <button onClick={handleDelete} disabled={submitting} className="btn btn-danger-outline">
                Remove
              </button>
            )}
            <button onClick={onClose} className="btn btn-secondary" disabled={submitting}>Cancel</button>
            <button
              onClick={handleSave}
              disabled={submitting || !clientId.trim() || (!existing && !clientSecret.trim())}
              className="btn btn-primary"
            >
              {submitting ? <LoadingSpinner size="sm" /> : (existing ? 'Save changes' : 'Create')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
