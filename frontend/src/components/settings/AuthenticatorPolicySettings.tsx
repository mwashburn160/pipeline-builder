// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react';
import { Fingerprint, Plus, X } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { OrgAuthenticatorPolicy } from '@/types';

const AAGUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

/** Canonical AAGUID, or null (mirrors the server's `normalizeAaguid`). */
export function normalizeAaguidInput(value: string): string | null {
  const v = value.trim().toLowerCase();
  return AAGUID_PATTERN.test(v) && v !== ZERO_AAGUID ? v : null;
}

/** Most catalog matches shown at once — the picker is a search, not a dump. */
const MAX_MATCHES = 8;

/**
 * The org's authenticator (passkey model) allowlist.
 *
 * Empty means any passkey. Once set:
 *   - registering a passkey while this org is active asks the authenticator to
 *     PROVE its make and model (direct attestation), checked against the FIDO
 *     Metadata Service; a model not on the list — or one that can't prove what
 *     it is, which includes most phone/laptop keychain passkeys — is refused;
 *   - a passkey not on the list still signs its owner in, but does NOT count as
 *     two-factor here, so where the org requires MFA it can't open a session.
 *
 * The members list below is the practical warning: who holds only passkeys the
 * list would not accept (and whether they have an authenticator app to fall
 * back on). Saving is step-up gated; widening or clearing a list also needs a
 * session opened with a second factor.
 */
export function AuthenticatorPolicySettings({ orgId, readOnly }: { orgId: string; readOnly: boolean }) {
  const toast = useToast();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [search, setSearch] = useState('');
  const [rawAaguid, setRawAaguid] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmingSave, setConfirmingSave] = useState(false);

  const read = useFetch(
    async (signal): Promise<OrgAuthenticatorPolicy | null> => (await api.getAuthenticatorPolicy(orgId, { signal })).data ?? null,
    [orgId],
  );
  const policy = read.data;

  useEffect(() => {
    if (policy) setDraft(policy.own.map((m) => m.aaguid));
  }, [policy]);

  /** Friendly names from MDS, plus whatever the server already named. */
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of policy?.mds.models ?? []) map.set(m.aaguid, m.model);
    for (const m of [...(policy?.own ?? []), ...(policy?.effective ?? [])]) if (m.model) map.set(m.aaguid, m.model);
    for (const m of policy?.compliance.modelsInUse ?? []) if (m.model) map.set(m.aaguid, m.model);
    return map;
  }, [policy]);
  const nameOf = (aaguid: string) => names.get(aaguid) ?? 'Unknown model';

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !policy) return [];
    return policy.mds.models
      .filter((m) => !(draft ?? []).includes(m.aaguid) && (m.model.toLowerCase().includes(q) || m.aaguid.includes(q)))
      .slice(0, MAX_MATCHES);
  }, [search, policy, draft]);

  const own = policy?.own.map((m) => m.aaguid) ?? [];
  const list = draft ?? own;
  const dirty = !!policy && (list.length !== own.length || list.some((a) => !own.includes(a)));
  const loosening = own.length > 0 && (list.length === 0 || list.some((a) => !own.includes(a)));

  const add = (aaguid: string) => {
    if (!list.includes(aaguid)) setDraft([...list, aaguid]);
  };
  const remove = (aaguid: string) => setDraft(list.filter((a) => a !== aaguid));
  const addRaw = () => {
    const v = normalizeAaguidInput(rawAaguid);
    if (!v) { setError('That is not an authenticator AAGUID (8-4-4-4-12 hex, not all zeros)'); return; }
    setError(null);
    add(v);
    setRawAaguid('');
  };

  const save = async (stepUpToken: string) => {
    try {
      const res = await api.updateAuthenticatorPolicy(orgId, { allowedAaguids: list }, stepUpToken);
      if (res.success) {
        toast.success(res.message || 'Authenticator policy saved');
        void read.refetch();
      }
      setError(null);
    } catch (e) {
      // e.g. AUTHENTICATOR_POLICY_LOCKOUT — the list would leave the admin
      // without an accepted factor in an org that enforces MFA.
      setError(formatError(e, 'Could not save the authenticator policy'));
    } finally {
      setConfirmingSave(false);
    }
  };

  const nonCompliant = policy?.compliance.nonCompliant ?? [];

  return (
    <SectionCard
      icon={Fingerprint}
      title="Approved authenticators"
      description="Limit the passkeys members may register — and that count as two-factor here — to specific security-key or authenticator models."
    >
      {error && <div className="mb-3"><ErrorAlert message={error} /></div>}

      {read.error && !policy ? (
        <RetryError message={formatError(read.error, 'Could not load the authenticator policy')} onRetry={read.refetch} />
      ) : !policy ? (
        <div className="flex items-center gap-2 py-4 text-sm text-fg-muted">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : (
        <div className="space-y-4">
          {policy.inheritedFrom.length > 0 && (
            <Callout variant="neutral">
              {policy.inheritedFrom.map((o) => o.name).join(', ')}{' '}
              {policy.inheritedFrom.length === 1 ? 'also limits' : 'also limit'} authenticators, so only models on
              every list apply here{policy.effective ? ` (${policy.effective.length} in force)` : ''}.
            </Callout>
          )}
          {!policy.mds.available && (
            <Callout variant="warning">
              The FIDO Metadata Service isn&apos;t available to this installation, so models can&apos;t be named or verified.
              While a list is set, passkey registrations here are refused until it is (see FIDO_MDS_BLOB_PATH / FIDO_MDS_URL).
            </Callout>
          )}

          <div>
            <p className="text-xs font-medium text-fg mb-1">
              Allowed models {list.length === 0 && <span className="font-normal text-fg-muted">— none set: any passkey is accepted</span>}
            </p>
            {list.length > 0 && (
              <ul className="divide-y divide-default border border-default rounded-lg">
                {list.map((aaguid) => (
                  <li key={aaguid} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium text-fg">{nameOf(aaguid)}</span>
                      <span className="block font-mono text-2xs text-fg-muted">{aaguid}</span>
                    </span>
                    <Button variant="ghost" size="xs" aria-label={`Remove ${nameOf(aaguid)}`} disabled={readOnly} onClick={() => remove(aaguid)}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {policy.mds.available && (
            <FormField label="Add a model" hint="Search the FIDO Metadata Service by name (e.g. YubiKey, Titan, Feitian).">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search models…" disabled={readOnly} />
            </FormField>
          )}
          {matches.length > 0 && (
            <ul className="border border-default rounded-lg divide-y divide-default">
              {matches.map((m) => (
                <li key={m.aaguid} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                  <span>{m.model}</span>
                  <Button variant="ghost" size="xs" aria-label={`Add ${m.model}`} disabled={readOnly} onClick={() => { add(m.aaguid); setSearch(''); }}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Add
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <FormField label="Or add by AAGUID" className="flex-1 min-w-[260px]">
              <Input value={rawAaguid} onChange={(e) => setRawAaguid(e.target.value)} placeholder="cb69481e-8ff7-4039-93ec-0a2729a154a8" disabled={readOnly} />
            </FormField>
            <Button variant="secondary" disabled={readOnly || !rawAaguid.trim()} onClick={addRaw}>Add</Button>
          </div>

          {policy.compliance.modelsInUse.length > 0 && (
            <div className="text-xs text-fg-muted">
              <p className="mb-1">Models your members use today:</p>
              <div className="flex flex-wrap gap-1.5">
                {policy.compliance.modelsInUse.map((m) => (
                  <button
                    key={m.aaguid}
                    type="button"
                    disabled={readOnly || list.includes(m.aaguid)}
                    onClick={() => add(m.aaguid)}
                    className="rounded-full border border-default px-2 py-0.5 hover:bg-surface-muted disabled:opacity-50"
                    title={m.aaguid}
                  >
                    {m.model ?? 'Unknown model'} · {m.count}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* WHO THE CURRENT LIST LEAVES OUT. Computed by the server against the
              list in force (not the unsaved draft), so it is what members face now. */}
          {nonCompliant.length > 0 && (
            <Callout variant="warning">
              <p className="font-medium">
                {nonCompliant.length} {nonCompliant.length === 1 ? 'member has' : 'members have'} passkeys the list in force
                does not accept. Those passkeys still sign them in, but don&apos;t count as two-factor here.
              </p>
              <ul className="mt-2 space-y-1">
                {nonCompliant.map((m) => (
                  <li key={m.userId}>
                    <strong>{m.email}</strong>
                    {' — '}
                    {m.passkeys.map((p) => `${p.name} (${p.model ?? p.aaguid ?? 'unknown model'})`).join(', ')}
                    {m.hasAuthenticatorApp ? ' · has an authenticator app' : ' · no authenticator app'}
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          <Callout variant="info">
            Keychain passkeys on phones and laptops usually can&apos;t prove their model, so an allowlist in practice means
            hardware security keys or managed authenticators. Members with other passkeys can still sign in; where this
            organization requires two-factor authentication they will need an approved passkey or an authenticator app.
          </Callout>

          {loosening && (
            <Callout variant="warning">
              Widening or clearing the list weakens your organization&apos;s protection, so it needs a session you opened
              with a passkey or an authenticator code.
            </Callout>
          )}

          <div className="flex justify-end">
            <Button type="button" readOnly={readOnly} disabled={!dirty} onClick={() => setConfirmingSave(true)}>
              Save
            </Button>
          </div>
        </div>
      )}

      {confirmingSave && (
        <StepUpModal
          title={list.length === 0 ? 'Accept any passkey?' : 'Save the approved authenticators?'}
          action={list.length === 0 ? 'Remove the authenticator allowlist' : `Allow ${list.length} authenticator model${list.length === 1 ? '' : 's'}`}
          details={(
            <p>
              {list.length === 0
                ? 'Any passkey will be accepted for registration and count as two-factor authentication here.'
                : 'New passkeys must be one of these models. Existing passkeys of other models stop counting as two-factor here.'}
            </p>
          )}
          onConfirmed={save}
          onClose={() => setConfirmingSave(false)}
        />
      )}
    </SectionCard>
  );
}
