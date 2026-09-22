// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState, useId } from 'react';
import { ShieldCheck } from 'lucide-react';
import api from '@/lib/api';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import { StepUpModal } from '@/components/admin/StepUpModal';
import type { Organization, OrgIdpConfigDto } from '@/types';
import { formatDateTime } from '@/lib/format';
import { formatError } from '@/lib/constants';
import { VerifiedDomainPicker } from '@/components/sso/VerifiedDomainPicker';

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
 * is optional. `allowedEmailDomains` is picked from the org's VERIFIED domains;
 * picking none means every verified domain of the org.
 */
export function OrgIdpConfigModal({ org, onClose, onSaved }: Props) {
  const uid = useId();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<OrgIdpConfigDto | null>(null);
  const [provider, setProvider] = useState<Provider>('generic-oidc');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [discoveryUrl, setDiscoveryUrl] = useState('');
  const [region, setRegion] = useState('');
  const [userPoolId, setUserPoolId] = useState('');
  const [allowedEmailDomains, setAllowedEmailDomains] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // Remove-config confirmation — the strong-factor step-up dialog IS it.
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Every write is strong-factor step-up gated on the server. The validated
  // write waits here while the step-up dialog is open (this modal hides
  // meanwhile and keeps its field values), then runs with the token. Sent bare,
  // the refusal went to the global dialog, whose replay saved the config while
  // this modal stayed open showing a failure.
  const [pendingWrite, setPendingWrite] = useState<((stepUpToken: string) => Promise<void>) | null>(null);

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
        // A SAML config carries neither (#4); this operator modal edits the OIDC
        // connection, so fall back to the empty form rather than crashing on it.
        if (c.provider) setProvider(c.provider);
        setClientId(c.clientId ?? '');
        setDiscoveryUrl(c.discoveryUrl || '');
        setRegion(c.region || '');
        setUserPoolId(c.userPoolId || '');
        setAllowedEmailDomains(c.allowedEmailDomains || []);
        setEnabled(c.enabled);
      }
    }).catch((err) => {
      if (cancelled) return;
      setError(formatError(err));
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

    const domains = allowedEmailDomains;

    // For cognito the server derives the discovery URL from region + userPoolId,
    // so only send those; other providers send discoveryUrl and never region/pool.
    const providerFields = provider === 'cognito'
      ? { region: region.trim(), userPoolId: userPoolId.trim(), discoveryUrl: undefined }
      : { discoveryUrl: provider === 'generic-oidc' ? (discoveryUrl || undefined) : undefined, region: undefined, userPoolId: undefined };

    setPendingWrite(() => async (stepUpToken: string) => {
      setSubmitting(true);
      try {
        if (existing) {
          // PATCH — only send the fields that changed; clientSecret only when supplied.
          const patch: Partial<{ provider: Provider; clientId: string; clientSecret: string; discoveryUrl: string; region: string; userPoolId: string; allowedEmailDomains: string[]; enabled: boolean }> = {
            provider, clientId, ...providerFields,
            allowedEmailDomains: domains, enabled,
          };
          if (clientSecret.trim()) patch.clientSecret = clientSecret;
          const res = await api.patchOrgIdpConfig(org.id, patch, stepUpToken);
          if (!res.success) throw new Error(res.message || 'Patch failed');
        } else {
          const res = await api.putOrgIdpConfig(org.id, {
            provider, clientId, clientSecret,
            ...providerFields,
            allowedEmailDomains: domains, enabled,
          }, stepUpToken);
          if (!res.success) throw new Error(res.message || 'Create failed');
        }
        onSaved?.();
        onClose();
      } catch (e) {
        setError(formatError(e));
      } finally {
        setSubmitting(false);
        setPendingWrite(null);
      }
    });
  }, [org.id, provider, clientId, clientSecret, discoveryUrl, region, userPoolId, allowedEmailDomains, enabled, existing, onSaved, onClose]);

  const handleDelete = useCallback(async (stepUpToken: string) => {
    setSubmitting(true);
    try {
      const res = await api.deleteOrgIdpConfig(org.id, stepUpToken);
      if (!res.success) throw new Error(res.message || 'Delete failed');
      onSaved?.();
      onClose();
    } catch (e) {
      setError(formatError(e));
      setSubmitting(false);
      setConfirmRemove(false);
    }
  }, [org.id, onSaved, onClose]);

  const stepUpOpen = pendingWrite !== null || confirmRemove;

  return (
    <>
    {!stepUpOpen && (
    <Modal
      title={`IdP Config — ${org.name}`}
      titleIcon={<ShieldCheck className="w-5 h-5 shrink-0" />}
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          {existing && (
            <Button variant="danger-outline" onClick={() => setConfirmRemove(true)} disabled={submitting}>
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
            <div className="rounded-lg bg-surface-muted px-3 py-2 text-sm">
              <div className="font-medium text-fg-muted mb-1">Current config</div>
              <div className="text-fg-muted">
                Provider: <code className="text-xs">{existing.provider}</code> ·
                {' '}Secret: {existing.hasClientSecret ? 'on file' : <em>not set</em>} ·
                {' '}Enabled: {existing.enabled ? 'yes' : 'no'} ·
                {' '}Updated: {formatDateTime(existing.updatedAt)}
              </div>
            </div>
          )}

          <div>
            <label className="label" htmlFor={`${uid}-provider`}>Provider</label>
            <Select
              id={`${uid}-provider`}
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
            <label className="label" htmlFor={`${uid}-client-id`}>Client ID</label>
            <Input
              id={`${uid}-client-id`}
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="oauth-client-id"
              className="font-mono text-sm"
              disabled={submitting}
            />
          </div>

          <div>
            <label className="label" htmlFor={`${uid}-client-secret`}>
              Client Secret
              {existing && <span className="text-xs text-fg-muted ml-2">(leave empty to keep existing)</span>}
            </label>
            <Input
              id={`${uid}-client-secret`}
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={existing ? '••••••••' : 'Set the OAuth client secret'}
              className="font-mono text-sm"
              disabled={submitting}
              autoComplete="new-password"
            />
            <p className="mt-1 text-xs text-fg-muted">
              Encrypted at rest under the org&apos;s key provider. Never echoed back on read.
            </p>
          </div>

          {provider === 'generic-oidc' && (
            <div>
              <label className="label" htmlFor={`${uid}-discovery-url`}>Discovery URL</label>
              <Input
                id={`${uid}-discovery-url`}
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
                <label className="label" htmlFor={`${uid}-region`}>Region</label>
                <Input
                  id={`${uid}-region`}
                  type="text"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="us-east-1"
                  className="font-mono text-sm"
                  disabled={submitting}
                />
              </div>
              <div>
                <label className="label" htmlFor={`${uid}-user-pool-id`}>User Pool ID</label>
                <Input
                  id={`${uid}-user-pool-id`}
                  type="text"
                  value={userPoolId}
                  onChange={(e) => setUserPoolId(e.target.value)}
                  placeholder="us-east-1_aB1cD2eF3"
                  className="font-mono text-sm"
                  disabled={submitting}
                />
                <p className="mt-1 text-xs text-fg-muted">
                  The discovery URL is derived server-side from the region and user pool.
                </p>
              </div>
            </>
          )}

          {/* Only the org's DNS-verified domains are eligible (the server refuses
              anything else), so this is the same picker the org's own SSO setup uses. */}
          <VerifiedDomainPicker
            orgId={org.id}
            value={allowedEmailDomains}
            onChange={setAllowedEmailDomains}
            disabled={submitting}
          />

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
    )}

      {pendingWrite && (
        <StepUpModal
          title={existing ? 'Save the IdP configuration?' : 'Create the IdP configuration?'}
          action={`${existing ? 'Update' : 'Create'} the SSO / IdP config for ${org.name}`}
          details={<p>This changes how members of {org.name} sign in.</p>}
          requireStrongFactor
          onConfirmed={pendingWrite}
          onClose={() => { if (!submitting) setPendingWrite(null); }}
        />
      )}

      {confirmRemove && (
        <StepUpModal
          title="Remove the SSO / IdP config?"
          action={`Remove the IdP config for "${org.name}"`}
          details={<p>Members who sign in through it can no longer do so until it is configured again.</p>}
          requireStrongFactor
          onConfirmed={handleDelete}
          onClose={() => { if (!submitting) setConfirmRemove(false); }}
        />
      )}
    </>
  );
}
